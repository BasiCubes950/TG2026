# Healthy Reddit: backend + parent portal

A Node server with zero dependencies (Node 18+). It does four things:

1. **Pairing that survives alt accounts.** The parent portal makes a 6-digit code (valid 10 min). When the teen's
   extension redeems it, the backend ties the parent's PIN and rules to that *browser install* (a device token)
   and records the Reddit username. If the teen logs out or switches accounts, the token stays, so protection
   stays on. Every username seen is shown to the parent.
2. **Multi-component scoring.** `POST /api/thread/check` scores the title, body and each sampled comment
   separately, combines them (`max(title, body, avg(comments), 0.85·max(comment))`), and returns a bucket:
   Safe / Low / Medium / High.
3. **Policy + PIN enforcement.** If the bucket is under an active 30-day block, the backend answers `redirect`.
   Otherwise a flagged thread gets `pause`. The parent's decision (`view` or `block`) is only accepted with the right PIN.
   After 5 wrong PINs, entry is locked for 5 minutes.
4. **Gemini coaching.** When a thread pauses, the backend asks Gemini right away for three calm tips about that
   thread, so they're ready by the time the parent walks over. Without a key, built-in tips are used.

## Run

    cd Reddit/backend
    GEMINI_API_KEY=your-key node server.js      # key optional
    # parent portal: http://localhost:8787

| Env var | Default | |
|---|---|---|
| `PORT` | 8787 | If you change it, update `chrome-extension/config.js` and `manifest.json` host_permissions |
| `GEMINI_API_KEY` | (none) | From Google AI Studio |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Any model that supports `generateContent` |
| `DB_FILE` | `./data.json` | JSON file storage (git-ignored) |
| `PIN_SECRET` | random, stored in DB | Key used to encrypt PINs at rest |

`GET /api/health` shows whether the SVM `model.json` and Gemini are being used.

## API

Parent (portal session token): `POST /api/parent/signup`, `POST /api/parent/login`, `GET /api/parent/me`,
`GET|POST /api/parent/pin`, `POST /api/parent/pairing`, `GET /api/parent/pairing/:code`,
`POST /api/parent/blocks/reset`, `POST /api/parent/children/:id/unpair`

Extension (device token): `POST /api/device/pair`, `POST /api/device/heartbeat`, `POST /api/thread/check`,
`POST /api/thread/coaching`, `POST /api/thread/decision`

## Prototype notes
- PINs are stored encrypted, not hashed, because the spec lets the parent reveal their PIN in the portal.
- Storage is a single JSON file. Use a real database before anyone depends on it.
- CORS is open (`*`) so the extension can call it. Tighten it when you deploy.
