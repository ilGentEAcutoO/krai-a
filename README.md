# Krai-a — AI Call Screener for Thai Phone Scams

Unknown call → forwarded once via `**21*` → Thai AI receptionist answers →
Gemini judges every turn (SCAM / LEGIT / UNSURE) → owner gets a LINE alert
with tape + reasons. Built for the AI Builder Cup (BFSI theme).

Live demo: https://krai-a-820054698900.asia-southeast1.run.app

## Quick start (2 minutes, no keys)

```sh
cd app
npm install
npm test
node src/server.js
```

Open http://localhost:8080 — the demo console runs fully offline in rules
mode. Add `GEMINI_API_KEY` to switch to live AI. Full guide: [app/README.md](app/README.md).

## Layout

- `app/src` — product code: verdict engine, Twilio voice adapter, LINE
  notify, member/call store, demo + self-service API
- `app/test` — node:test suite (verdict, gates, auth, plans, privacy)
- `app/public` — marketing site + member dashboard
- `deploy-cloudrun.sh` — one-command Cloud Run deploy (`PROJECT_ID=… ./deploy-cloudrun.sh`)
- `research/` — hackathon theme notes

Secrets (API keys, tokens) live in Secret Manager / `.env` only — never in
this repo. See `app/.env.example`.

## License

MIT — see [LICENSE](LICENSE).
