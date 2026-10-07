# Krai-a (demo) — AI Call Screener for Thai Phone Scams

Unknown call → Thai AI receptionist answers → Gemini judges every turn
(SCAM / LEGIT / UNSURE) → verdict + one-click police evidence. Built for
the AI Builder Cup (BFSI theme).

Live demo: https://demo.krai-a.com · backup:
https://krai-a-demo-820054698900.asia-southeast1.run.app

## Try it in 1 minute (judges)

1. Open `/demo.html`, pick a scam script (fake police, parcel OTP…), press
   **Start call** — or type freestyle as the caller.
2. Watch the verdict update turn by turn, with reasons in Thai + English.
3. When the call ends, download the evidence bundle (transcript + verdict
   + integrity hash) — the same file a victim files with AOC 1441 / police.
4. Real phone path: Twilio webhooks live at `/voice/*` — point a Thai
   number at them and forwarded calls land in the same sessions.

No signup, no keys needed — without `GEMINI_API_KEY` the demo runs fully
offline on the built-in rules engine.

## Layout

- `app/src` — verdict engine, Gemini adapter, Twilio voice adapter,
  demo API, evidence export, privacy notice
- `app/test` — node:test suite (31 tests: verdict, gates, store, privacy, demo loop)
- `app/public` — landing + live demo console (Thai-first, EN toggle)
- `deploy-demo.sh` — one-command Cloud Run deploy

The full product (OTP signup, plans, LINE/WhatsApp alerts, LIFF, member
dashboard) lives in a private repo — this repo is the lean hackathon build.

## License

MIT — see [LICENSE](LICENSE).
