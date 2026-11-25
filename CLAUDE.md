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

## Architecture
- No build step. Node 20+, Express 5, `ws`, ES modules.
- `server.js`: HTTP API, pages, and the WebSocket switchboard at `/ws` (`hello` → `knock`/`answer`/`decline`/`end`/`signal`/`pause`/`approve`/`mode`). Media is peer-to-peer WebRTC; the visitor makes the offer, after the home screen has answered.
- `lib/store.js`: one JSON file (`DATA_FILE`), atomic writes. Only SHA-256 hashes of link secrets are stored.
- `public/`: plain HTML/CSS/JS, one script per page (`home`, `visit`, `organize`, `setup`) plus `js/common.js`. Large type and buttons on the home screen; keep it usable by someone with poor sight or hearing.
- Link secrets go after `#` so they never reach server logs.

## Commands
- `npm start` / `npm run dev`
- `npm test` (unit + server flow)
- `npm run e2e` (two real Chromium browsers with fake cameras; `SHOTS=dir` saves screenshots)

Every change to the rules or the visit flow needs a test.

## Notifications
Never send Slack messages or notifications about this project. Report status in the session or on GitHub.
