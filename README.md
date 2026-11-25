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
- Nothing is recorded. Video and sound go directly between the two devices (WebRTC); the server only introduces them and enforces the rules. It keeps no log of who visited when.
- Visitors never learn who else visits.
- The camera is used only during a visit.

### Links and privacy

Each link carries a long random secret after the `#`, which browsers never send to servers. Only a SHA-256 hash of each secret is stored. Removing a visitor, or making a new home screen or organizer link, makes the old link stop working at once. Every page is `noindex` and sends no referrer.

## Running it

```
npm install
npm start            # http://localhost:3000, then open /setup
npm test             # rules, storage and the server's visit flow
npm run e2e          # a real visit between two Chromium browsers with fake cameras (needs Playwright)
```

Settings (environment variables):

| Name | What it does |
| --- | --- |
| `PORT` | Port to listen on (default 3000). |
| `SETUP_PASSWORD` | Required to create a home. Without it, anyone who can reach the server can create one, so always set it when deployed. |
| `DATA_FILE` | Where the data file lives (default `data/db.json`). |
| `ICE_SERVERS` | JSON list of STUN/TURN servers for WebRTC. Defaults to a public STUN server. |

Camera and microphone need HTTPS (or `localhost`).

## Not done yet

- **A TURN server.** Without one, some visits will fail to connect on strict home or mobile networks. Add one (for example Cloudflare Realtime TURN or Twilio) through `ICE_SERVERS`.
- **Hosting.** It needs HTTPS and storage that survives restarts (a persistent disk, or Postgres in place of the JSON file).
- **AI help:** live captions, translation, and visit reminders for family.
- Photos of visitors in place of initials; a kiosk setup guide for the tablet; a small robot visitors can drive around the home, later.
