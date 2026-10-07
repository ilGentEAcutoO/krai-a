# Krai-a demo — app

Lean hackathon build: web call sessions + real Twilio voice path + console
alerts + evidence export. No auth, no billing, no LINE (see private repo).

## Quick start (2 minutes, no keys)

```sh
npm install
npm test
node src/server.js
```

Open http://localhost:8080/demo.html — rules mode works offline. Set
`GEMINI_API_KEY` (see `.env.example`) for live AI.

## Endpoints

| Method | Path | What |
|---|---|---|
| GET | `/health`, `/privacy` | liveness, short privacy notice |
| GET | `/api/status` | engine (`rules`/`gemini`), model, demo number |
| GET | `/api/demo/scripts` | scripted scam scenarios |
| POST | `/api/demo/call` | start a web session `{scriptId?, callerPhone?}` |
| POST | `/api/demo/turn` | one caller line `{callId, text}` → verdict + reply |
| POST | `/api/demo/end` | force-end `{callId}` → verdict + alert |
| GET | `/api/demo/export/:callId` | evidence bundle (transcript + verdict + sha256) |
| GET | `/api/calls` | session history (web + phone) |
| POST | `/voice/incoming`, `/voice/turn`, `/voice/status` | Twilio webhooks |
| WS | `/ws` | live call updates (second-screen judging) |

## Deploy

```sh
PROJECT_ID=my-proj ./deploy-demo.sh   # from repo root
```

Needs `gemini-api-key` in the project's Secret Manager (script checks).
