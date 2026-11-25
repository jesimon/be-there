# Be There

Telepresence for families: lets the people who love someone who is housebound or far away be present with them, not just call them.

A Gladspring venture, founded by Jeremy and Suzanne Simon. Private and an early preview.

## How it works

- **The home screen** (`/home#…`) runs full-screen on a tablet in the home of the person being visited. It shows a big clock, who may visit, and few, large buttons.
- **Visitors** (`/visit#…`) open their own link on a phone or computer and knock. Or, if the person at home allows it, they come straight in after a few seconds' notice the person at home can refuse.
- **The organizer** (`/organize#…`) is the family member who sets it up: they invite visitors, set visiting hours, replace lost links and can delete the home.

### The person at home is in charge

- Nobody can visit until **they** say yes on their own screen; organizers can only invite.
- Only they choose who may come straight in, and only they pause or resume visits.
- Every visit shows a red light and the visitor's name the whole time, with a large "End visit" button.
- Visits happen only within visiting hours, in the home's own time zone.
- Nothing is recorded. Video and sound go straight between the two devices when their networks allow it. When a network blocks that, they go through Cloudflare's relay instead, encrypted from one device to the other, so the relay cannot see or hear them (see "The relay" below). They never pass through our server: it only introduces the two devices and enforces the rules, and it keeps no log of who visited when.
- Visitors never learn who else visits.
- The camera is used only during a visit.

### The relay

On mobile data, some home routers and most workplaces, two devices cannot reach each other directly. Without help such a visit rings, is answered, and then shows nothing. The relay (Cloudflare Realtime TURN) is that help.

- **Direct first.** Every visit starts by trying a direct connection. Only if it has not connected after about 5 seconds, or it later drops, does our server ask Cloudflare for relay credentials. Most visits never touch the relay.
- **For one visit only.** The credentials are made for that visit, given only to its two devices, and revoked when it ends, however it ends. (If Cloudflare cannot be reached at that moment, or our server stops without warning, they run out by themselves after `TURN_TTL_SECONDS`.) They are never stored or logged, and never appear in anything the server sends to anyone else.
- **What Cloudflare can see.** The relay carries only encrypted picture and sound. Cloudflare does see the two devices' network addresses and when and how much the relay was used, and the Cloudflare account that holds the key keeps those usage figures for each visit that asked for the relay. Our server still keeps nothing. At the start of every visit, relayed or not, each device also asks Cloudflare's public STUN server (`stun.cloudflare.com`) for its own public address.
- **When nothing works.** A visit that cannot connect within 30 seconds, or loses its connection and cannot get it back, ends by itself, and both sides are told in plain words.
- **Checking it.** The organizer page says "Relay: ready" or "Relay: not set up", and its "Test the relay" button checks the key without a visit. During a visit the visitor's page says "Connected directly." or "Connected through the relay." in one small line. Adding `?relay=1` before the `#` of a visitor link (`/visit?relay=1#…`) sends that visit through the relay from the start. The home screen never shows any of this.

### Links and privacy

Each link carries a long random secret after the `#`, which browsers never send to servers. Only a SHA-256 hash of each secret is stored. Removing a visitor, or making a new home screen or organizer link, makes the old link stop working at once. Every page is `noindex` and sends no referrer.

### The two addresses

Be There answers at two addresses, and both work for good:

- `https://bethere.gladspring.org`, the new one;
- `https://be-there-gp50.onrender.com`, the first one. Devices already in use hold their links there, so it is never switched off and never redirected.

Both reach the same server, so a home screen at one address and a visitor at the other meet as usual. A browser, though, treats them as two different sites: what it remembers at one it does not know at the other, and it asks for the camera and microphone again at the new one.

- **How a device moves.** The server never redirects (a link saved without its `#` would arrive with no secret, and the live connection cannot follow a redirect). When `CANONICAL_ORIGIN` is set, a visitor, organizer or setup page that is opened at the old address moves itself as it loads, before it connects to anything. It first checks that the new address answers: it opens the same live connection visits use (`/ws`) there, sends nothing, and closes it. Only if that opens within 4 seconds does the page go to the new address, taking its link's secret along after the `#`. Otherwise it stays where it is and works as before. Nothing is forgotten at the old address. The first visit at the new address asks for the camera and microphone once more.
- **The home screen never moves by itself.** The tablet would ask to use the camera and microphone again, and that question must not appear unannounced in front of the person at home. It keeps working at the address it is on.
- **Moving the home screen.** On the organizer page, press "New home screen link" and open the new link on the tablet while someone is with them. Allow the camera and microphone when it asks. As with any new home screen link, the old screen stops working at once.
- **New links.** Once `CANONICAL_ORIGIN` is set, the links the organizer and setup pages make point at the new address, whichever address those pages were opened at.
- **The setting.** `CANONICAL_ORIGIN` is accepted only when it is exactly the address built into the code (`lib/address.js`), `https://bethere.gladspring.org`. Anything else is ignored, with one line at startup that does not repeat the value: a slip in the settings must never send secret links to another site. Unset it and devices stop moving; those already at the new address carry on there. (On Render: remove the line from `render.yaml` and delete the variable on the service's Environment page.)
- **DNS.** One record at Cloudflare for gladspring.org: a CNAME named `bethere` pointing to `be-there-gp50.onrender.com`, set to "DNS only" (grey cloud). Never switch it to "Proxied": Cloudflare lists live connections (WebSockets) as not supported when a proxied record points at a host like Render, and Be There depends on them. The domain itself is attached to the service in `render.yaml` (`domains:`).

Over HTTPS the server also tells browsers to keep using HTTPS at that address (`Strict-Transport-Security`, for that address alone).

### Keeping the tablet ready

The setup page (when it is done) and the organizer page (under "Links") carry four short reminders: keep the tablet plugged in; on an iPad set Settings > Display & Brightness > Auto-Lock to Never; leave Be There open on the screen; tap the screen once after opening it, so the chime can sound.

## Running it

```
npm install
npm start            # http://localhost:3000, then open /setup
npm test             # rules, storage, the relay, the new address and the server's visit flow
npm run e2e          # real visits between two Chromium browsers with fake cameras, directly and
                     # through a relay on this machine, and pages moving to the new address
                     # (needs Playwright; takes about a minute and a half)
```

`npm install` also brings `node-turn`, a small relay server used only by `npm run e2e`. It is a development dependency: the app never loads it, and a production install (`NODE_ENV=production`, as on Render) leaves it out.

Settings (environment variables):

| Name | What it does |
| --- | --- |
| `PORT` | Port to listen on (default 3000). |
| `SETUP_PASSWORD` | Required to create a home. Without it, anyone who can reach the server can create one, so always set it when deployed. |
| `DATA_FILE` | Where the data file lives (default `data/db.json`). |
| `ICE_SERVERS` | JSON list of public STUN servers to use in place of Cloudflare's. Anyone can read this list, so only STUN entries without a username or password are used; the relay never goes here. |
| `TURN_KEY_ID` | The relay: the ID of a Cloudflare Realtime TURN key (32 letters and digits). |
| `TURN_API_TOKEN` | The relay: that key's API token. A secret. |
| `TURN_TTL_SECONDS` | How long relay credentials last if they are not revoked first (default 43200, which is 12 hours; between 600 and 172800). They are revoked when the visit ends. On a visit that outlasts them the visitor's page fetches newer ones, up to three times. |
| `CANONICAL_ORIGIN` | Be There's new address. When set, visitor, organizer and setup pages opened at any other address move to it, and new links point at it (see "The two addresses"). Only `https://bethere.gladspring.org` is accepted; any other value is ignored. Set in `render.yaml`. Leave it unset on a developer's machine. |

The two `TURN_` values are set by hand in the host's settings (on Render: the service's Environment page). They are not in `render.yaml` and must never be committed. Without them, or while they still hold placeholder text, the relay is off: visits connect directly only, and the server says so in one line when it starts.

Camera and microphone need HTTPS (or `localhost`).

## Not done yet

- **Trying the relay for real.** It is tested against a relay on the developer's machine. It still needs a first check with the real Cloudflare key: "Test the relay" on the organizer page, then a visit from a phone on mobile data.
- **Trying the move to the new address for real.** It is tested in Chromium, with two names for one server on the developer's machine. It still needs a first check on an iPhone and an iPad: open a visitor link at the old address and see it arrive at the new one, then move the home screen with a new home screen link.
- The organizer page does not know which address the tablet is at, so its note about moving the home screen stays up after the tablet has moved.
- **Hosting.** It needs HTTPS and storage that survives restarts (a persistent disk, or Postgres in place of the JSON file).
- **AI help:** live captions, translation, and visit reminders for family.
- Photos of visitors in place of initials; a fuller kiosk setup guide for the tablet (today there are the four reminders under "Keeping the tablet ready"); a small robot visitors can drive around the home, later.
