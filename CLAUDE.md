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

## Architecture
- No build step. Node 20+, Express 5, `ws`, ES modules. `node-turn` is a devDependency used only by `test/e2e.mjs`.
- `server.js`: HTTP API, pages, and the WebSocket switchboard at `/ws` (`hello` → `knock`/`answer`/`decline`/`end`/`signal`/`relay`/`pause`/`approve`/`mode`). Media is peer-to-peer WebRTC; the visitor makes the offer, after the home screen has answered.
- `lib/ice.js`: the public STUN list, the relay's settings, and minting and revoking relay credentials (fetch and the environment are passed in; nothing is logged).
- `lib/store.js`: one JSON file (`DATA_FILE`), atomic writes. Only SHA-256 hashes of link secrets are stored.
- `public/`: plain HTML/CSS/JS, one script per page (`home`, `visit`, `organize`, `setup`) plus `js/common.js` and `js/peer.js`. Large type and buttons on the home screen; keep it usable by someone with poor sight or hearing.
- `public/js/peer.js`: the video link for one visit and its timeline (`TIMES`: ask for the relay after 5 s, give up after 30 s, try again after a drop). It takes its timers and `RTCPeerConnection` as arguments so `test/peer.test.js` can run it without a browser.
- Link secrets go after `#` so they never reach server logs.
- The home screen stays open for days, so an old page talks to a new server after every deploy. Keep every existing WebSocket message, HTTP route and `common.js` export working (`makePeer` is kept for this); add, never rename. Pages, scripts and styles are served with `Cache-Control: no-cache`.

## Commands
- `npm start` / `npm run dev`
- `npm test` (unit + server flow + the relay timeline; the relay is always a fake, nothing calls Cloudflare)
- `npm run e2e` (two real Chromium browsers with fake cameras, directly and through a local relay; about a minute; `SHOTS=dir` saves screenshots)

Every change to the rules or the visit flow needs a test.

## Notifications
Never send Slack messages or notifications about this project. Report status in the session or on GitHub.
