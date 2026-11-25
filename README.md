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

## Running it

```
npm install
npm start            # http://localhost:3000, then open /setup
npm test             # rules, storage, the relay and the server's visit flow
npm run e2e          # real visits between two Chromium browsers with fake cameras, directly and
                     # through a relay on this machine (needs Playwright; takes about a minute)
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

The two `TURN_` values are set by hand in the host's settings (on Render: the service's Environment page). They are not in `render.yaml` and must never be committed. Without them, or while they still hold placeholder text, the relay is off: visits connect directly only, and the server says so in one line when it starts.

Camera and microphone need HTTPS (or `localhost`).

## Not done yet

- **Trying the relay for real.** It is tested against a relay on the developer's machine. It still needs a first check with the real Cloudflare key: "Test the relay" on the organizer page, then a visit from a phone on mobile data.
- **Hosting.** It needs HTTPS and storage that survives restarts (a persistent disk, or Postgres in place of the JSON file).
- **AI help:** live captions, translation, and visit reminders for family.
- Photos of visitors in place of initials; a kiosk setup guide for the tablet; a small robot visitors can drive around the home, later.
