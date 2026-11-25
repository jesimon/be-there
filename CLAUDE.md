# CLAUDE.md

Context for working on Be There in Claude Code.

## Purpose
Be There is a Gladspring venture (founders: Jeremy and Suzanne Simon; private): telepresence that lets family, friends and, with consent, caregivers be present with someone who is housebound or far away. Its plan and projections live in the Gladspring planning app (`jesimon/gladspring`, venture id `be-there`); this repository is the product. Benefit first: it exists to make lonely days fewer, not to sell screens.

## The person at home is in charge (never weaken this)
- A visitor can visit only after the person at home approves them on the home screen. Organizers invite; they cannot approve, change drop-in, or pause/resume.
- Drop-in always gives the home screen notice (`DROP_IN_NOTICE_SECONDS`) that can be refused.
- During every visit the home screen shows the visitor's name and a red light, with a one-tap "End visit".
- Nothing is recorded or logged about visits. No analytics. Visitors never see who else visits.
- The rules live in `lib/rules.js` (pure, tested) and are enforced on the server, not only in the browser.

## The relay (never weaken this either)
- Media never passes through our server. A visit always tries a direct connection first, with public STUN only (`stun.cloudflare.com`). The relay (Cloudflare Realtime TURN) is asked for only when a visit has not connected after about 5 seconds, or later drops: each relayed visit leaves usage figures in the owners' Cloudflare account, so most visits must stay off it.
- Relay credentials are made per visit by our server (`lib/ice.js`), only when one of the two devices of a live visit asks (WebSocket `relay`), are sent to the home screen first and then the visitor, and are revoked when the visit ends for any reason: everything goes through `endCallIf`, including deleting the home and stopping the server. At most 4 mints per visit.
- Credentials never appear in `/api/config` (public STUN only, whatever `ICE_SERVERS` holds), in any other HTTP response, in the logs or in storage. `TURN_KEY_ID` and `TURN_API_TOKEN` are set by hand on Render; never put them in `render.yaml` or the repository. Placeholder text in them counts as "not set up".
- A device ends a visit that never connected, or lost its connection for good, with `end` and `reason: 'no_connection'`. The server passes that reason on only for a visit that was answered; any other reason, or a knock still ringing, is passed on as `ended`.
- The home screen says nothing about how a visit is connected (after a visit that could not connect: "The last visit couldn’t connect." for a minute). The visitor page says it in one small line, the only place it uses the word "relay". The organizer page may say "relay".

## The two addresses (never weaken this either)
- Be There answers at `https://bethere.gladspring.org` (new) and `https://be-there-gp50.onrender.com` (the first one), one server behind both. The first must keep working for ever: devices hold their links there, and a browser treats the two as different sites (storage and camera permission are separate).
- Never redirect on the server, never check or act on the Host header, never disable the onrender.com address (no `renderSubdomainPolicy`), and keep the DNS record "DNS only". Every route answers the same at either address; `/healthz` and `/ws` must never get a 3xx.
- The allow-list is in the code: `CANONICAL_ALLOW` in `lib/address.js` (pure, tested). `CANONICAL_ORIGIN` counts only when it is exactly an entry of that list; anything else is ignored with one generic startup line that never repeats the value. `createApp({ canonicalOrigin, canonicalAllow })` exists for tests only; production reads the environment and the fixed list. The hand-off puts link secrets in a URL at that address, so never make the list configurable.
- A device moves only from inside its own page (`public/js/moved.js`, `goToNewAddress(kind, token)`): once, at page load, before anything connects; only when `/api/config` names a `canonicalOrigin` and a WebSocket to its `/ws` opens within 4 seconds (nothing is sent on it); with the secret after the `#`. Otherwise the page stays. The old address's remembered link is never cleared. `moved.js` imports nothing, so an older cached `common.js` cannot stop a page.
- Never move the home screen automatically: `home.js` must not load `moved.js` (a test checks). A camera prompt at a new address must not land on the person at home unannounced. It moves only when a family member opens a new home screen link (which the organizer page makes at the new address) on the tablet.
- Links made on the organizer and setup pages use `canonicalOrigin || location.origin`.

## Photos of visitors (never weaken this either)
- Only the organizer adds, changes or removes a visitor's photo (`PUT`/`DELETE /api/organize/visitors/:id/photo`). Visitors cannot upload, there is no photo route for a visitor's link, and `visitorView()` and every message to a visitor's page say nothing about photos. A photo the organizer adds shows on the home screen straight away; the name always stays in large text beside it.
- The server trusts no upload. `lib/jpeg.js` (pure, tested) checks the JPEG's structure and rebuilds it strictly: a fixed JFIF header of our own first (never bytes from the upload), then only tables, frame and scans; EXIF, ICC profiles, comments, every other APPn segment and anything after the end marker are dropped; a file with an Adobe APP14 marker is refused; at most 4 tables in a quantization segment; every table or part a frame or scan names must have been given. Accepted: 8-bit, 1 or 3 components, baseline/extended/progressive, square, 96 to 512 px, EXIF orientation absent or 1, at most 16 scans, at most 200 KB. No image library; the organizer's browser makes the 384 px square (`squarePhoto()` in `public/js/photo.js`), and the original file is never uploaded.
- A photo is fetched once for each version and never because of a visit. `homeView()` gives each visitor's `photo` tag; the home screen calls `getPhotoUrl()` only when a `state` message arrives, which asks the server only for a tag it has not seen, and keeps the picture in memory (`cache: 'no-store'`, so the browser makes no checking requests of its own). The knock screen and the in-visit label use `cachedPhotoUrl()`, which never asks. A failed fetch is retried by timer only (`RETRY_AFTER`). The host can log request paths, so a photo request at the moment of a knock would be a log of visits.
- Photo responses always carry `Content-Type: image/jpeg`, `nosniff`, `Content-Disposition: attachment`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: private, no-cache` and `Vary: Authorization`. The home screen reads only its own visitors' photos, with its link secret as a Bearer token.
- Uploads and photo requests are never logged, errors included (the handler after the routes in `server.js` answers them itself, because Express would print them).
- One file per visitor, no history: `photos/<home id>/<visitor id>.jpg` beside `DATA_FILE` (`lib/photos.js`; in memory for a `':memory:'` store, so tests never write into the repository). `store.removeVisitor()` and `store.deleteHome()` delete the files; the visitor's record holds only `photo: { etag, updatedAt }`.

## Architecture
- No build step. Node 20+, Express 5, `ws`, ES modules. `node-turn` is a devDependency used only by `test/e2e.mjs`.
- `server.js`: HTTP API, pages, and the WebSocket switchboard at `/ws` (`hello` → `knock`/`answer`/`decline`/`end`/`signal`/`relay`/`pause`/`approve`/`mode`). Media is peer-to-peer WebRTC; the visitor makes the offer, after the home screen has answered.
- `lib/ice.js`: the public STUN list, the relay's settings, and minting and revoking relay credentials (fetch and the environment are passed in; nothing is logged).
- `lib/address.js`: the one address devices may be sent on to, and the check of `CANONICAL_ORIGIN` against it.
- `lib/store.js`: one JSON file (`DATA_FILE`), atomic writes. Only SHA-256 hashes of link secrets are stored. It also looks after visitors' photos through a keeper from `lib/photos.js` (`createStore(file, { photos })`).
- `lib/jpeg.js`: `inspectJpeg`, `rebuildJpeg` and `acceptPhoto` for visitors' photos. `lib/photos.js`: where the files are kept (`photosInFolder`, `photosInMemory`).
- `public/`: plain HTML/CSS/JS, one script per page (`home`, `visit`, `organize`, `setup`) plus `js/common.js`, `js/peer.js`, `js/moved.js` (the move to the new address; not used by `home`) and `js/photo.js` (making, fetching and showing photos; used by `home` and `organize`, never by `visit`; it imports nothing). Large type and buttons on the home screen; keep it usable by someone with poor sight or hearing.
- `public/js/peer.js`: the video link for one visit and its timeline (`TIMES`: ask for the relay after 5 s, give up after 30 s, try again after a drop). It takes its timers and `RTCPeerConnection` as arguments so `test/peer.test.js` can run it without a browser.
- Link secrets go after `#` so they never reach server logs.
- The home screen stays open for days, so an old page talks to a new server after every deploy. Keep every existing WebSocket message, HTTP route and `common.js` export working (`makePeer` is kept for this); add, never rename. Pages, scripts and styles are served with `Cache-Control: no-cache`.

## Commands
- `npm start` / `npm run dev`
- `npm test` (unit + server flow + the relay timeline + the new address + photos; the relay is always a fake, nothing calls Cloudflare, and nothing is written into the repository)
- `npm run e2e` (two real Chromium browsers with fake cameras, directly and through a local relay, a photo added, changed and removed with every photo request of the home screen counted, then pages moving between two names for one local server; about a minute and a half; `SHOTS=dir` saves screenshots)

Every change to the rules or the visit flow needs a test.

## Notifications
Never send Slack messages or notifications about this project. Report status in the session or on GitHub.
