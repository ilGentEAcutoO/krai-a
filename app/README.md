# Krai-a — AI Call Screener for Thai Phone Scams

Unknown call → forwarded once via `**21*` → Thai AI receptionist answers →
Gemini judges every turn (SCAM / LEGIT / UNSURE) → owner gets a notification
with tape + reasons. Built for the AI Builder Cup (BFSI theme).

One Cloud Run service: marketing site + member app + Twilio voice webhooks
+ demo API + judge console. Product pages are Thai-first; the judge surface
(`/demo.html`, code, docs) is English.

## Quick start (2 minutes, no keys)

```sh
cd app
npm install
npm test
npm start
```

Open http://localhost:8080 — the landing page with a live verdict widget.
Sign up at `/start.html` (OTP is shown in-browser in mock-SMS mode), get an AI
number, and manage everything in `/dashboard.html`. Judges: `/demo.html` runs
the scripted 3-scam live-call console. This runs on the built-in rules engine,
no network needed.

## Live AI mode (Gemini)

```sh
cp .env.example .env   # set GEMINI_API_KEY
npm start
```

The console status pill switches from MOCK to LIVE. Every verdict reports its
`engine` (`gemini` / `rules` / `hard-rule`) so judges can see what decided.

Get a key: https://aistudio.google.com/apikey (free tier is enough for demo).

## Real phone loop (Twilio)

1. Twilio Console → buy a number, upgrade from trial.
2. Phone number → Voice → webhook `POST https://<cloud-run-url>/voice/incoming`,
   status callback `POST https://<cloud-run-url>/voice/status`.
3. Set `TWILIO_ACCOUNT_SID`, `DEMO_NUMBER` in env, redeploy.
4. From your phone dial `**21*<ai-number>#` (all calls) or `**61*<ai-number>#`
   (unanswered only). Call your own number from another phone — the AI answers.

Production note: the AI number must be Thai, otherwise owners pay IDD rates on
every forwarded leg.

## Deploy (live: https://krai-a.com)

```sh
cd app && npm run deploy   # wrangler: Worker + container, custom domain attached
```

The app runs as one stateful container (members/calls/OTP live in process
memory) behind a Worker singleton (`worker-src/index.js`), so no code changes
were needed. It sleeps after 30m idle — state resets on wake, fine for demo.
Needs Docker Desktop running locally for the image build.

Legacy path: `PROJECT_ID=your-project REGION=asia-southeast1
./deploy-cloudrun.sh` from repo root (needs gcloud + a GCP project).

## Pages

| Path | Purpose |
|---|---|
| `/` | landing + live verdict widget + forwarding simulator |
| `/features.html`, `/how-it-works.html`, `/family.html`, `/pricing.html` | sales pages (Family = 2 protected numbers) |
| `/start.html` | signup/login via phone OTP (`?plan=` preselects tier) |
| `/dashboard.html` | member app (plan, usage, family numbers, LINE, tapes, whitelist, watchers, cancel) |
| `/demo.html` | judge live-call console (5 scenarios + AI-number banner) |

## Plans (trial-first, USD + Thai PPP)

| Plan | USD (EN) | THB PPP (TH) | Min/mo | Calls/mo | Protected | Watchers | Tapes |
|---|---|---|---|---|---|---|---|
| Starter | $2 | ฿20 (−71%) | 10 | 5 | 1 | 0 | — |
| Plus | $6 | ฿100 (−52%) | 50 | 25 | 1 | 0 | ✓ |
| Family | $8 | ฿149 (−47%) | 75 | 40 | 2 | 2 | ✓ |

EN mode shows USD global prices; TH mode shows PPP-adjusted baht (≈$1=฿35).
Every plan starts with a free 7-day trial, no card. Cancel anytime in two
layers: dial `##21#` to stop forwarding, then cancel in the dashboard.

AI numbers are always Thai (`02-100-01xx` in demo, real Thai numbers via
Twilio in production) — forwarding stays domestic, never IDD.

Sessions are browser-locked: OTP login issues a token kept in `localStorage`
(30 days). No passwords yet.

## API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness |
| POST | `/voice/incoming` | Twilio inbound (member gate → TwiML) |
| POST | `/voice/turn` | Twilio speech turn (`?callId=`) |
| POST | `/voice/status` | Twilio status callback |
| POST | `/api/analyze` | single-shot verdict `{text}` |
| POST | `/api/auth/request-otp` | send OTP `{phone}` |
| POST | `/api/auth/verify-otp` | verify → `{token, member, isNew}` |
| POST | `/api/auth/logout` | invalidate token |
| GET | `/api/me` | own profile (auth) |
| POST | `/api/me/forwarding` | confirm `**21*` setup (auth) |
| GET/POST/DELETE | `/api/me/whitelist` | known numbers + safe word (auth) |
| GET/POST/DELETE | `/api/me/watchers` | family watchers (auth) |
| GET | `/api/me/calls`, `/api/me/usage` | tapes + quota (auth) |
| GET | `/api/plans` | plan catalog + trial days |
| POST | `/api/me/plan` | switch plan `{plan}` (auth) |
| GET/POST | `/api/me/numbers` | protected numbers, plan-capped (auth) |
| POST | `/api/me/notify` | link/unlink LINE `{lineUserId}` (auth, optional) |
| POST | `/api/me/cancel`, `/api/me/reactivate` | cancel / resume membership (auth) |
| GET | `/api/status` | engine / mode / adapters |
| GET | `/api/demo/scripts` | 5 judge scenarios |
| POST | `/api/demo/call` | start simulated call `{scriptId?}` |
| POST | `/api/demo/turn` | caller line `{callId, text}` → reply + verdict |
| POST | `/api/demo/end` | force-end `{callId}` → notify |
| GET | `/api/calls`, `/api/calls/:id` | history + tapes |
| WS | `/ws` | live call updates (second-screen judging) |

## Architecture

```
caller ──PSTN──▶ carrier (**21*) ──▶ Twilio number ──TwiML/Gather──▶ Cloud Run
                                                                        │
                                                     ┌──────────────────┼──────────────────┐
                                                     │  member gate     │  persona (Thai)  │
                                                     │  To/ForwardedFrom│  Gemini / canned │
                                                     │  reject ~10s     │  never accuses   │
                                                     └────────┬─────────┴─────────┬────────┘
                                                              │  verdict authority (code only)
                                                              │  hard rules → Gemini → 0.8 gate
                                                              ▼
                                                     notify adapters (console / LINE / …)
```

Key invariants (see `instruction/work` briefs for rationale):

- Only `src/verdict.js` decides outcomes; the voice persona can never order a
  transfer or hangup.
- Requests beat numbers: even whitelisted callers asking for money/OTP/remote
  access enter safe-word + callback verification.
- Thin evidence = UNSURE, never an accusation. False alarms kill trust.
- Rejects cost ~10s of inbound audio and zero AI.
- Secrets live in env / Secret Manager only. `.env.example` lists everything.

## Costs (demo)

Free tier covers Cloud Run + Gemini free quota + 1 Twilio number (~$1.15/mo).
A ~2-minute screened call stays under ~฿3 all-in; see
`instruction/work/f4-costmodel.html` for the per-line model.

## เริ่มต้นเร็ว (ไทย)

1. `cd app && npm install && npm start` แล้วเปิด http://localhost:8080
2. เลือกสคริปต์ กด Start call → Auto-play script ดู verdict แดง/เขียว/เหลือง
3. อยากใช้ AI จริง: ใส่ `GEMINI_API_KEY` ใน `.env` (ขอฟรีที่ AI Studio)
4. อยากโทรจริง: ซื้อเบอร์ Twilio ชี้ webhook มาที่ Cloud Run แล้วกด `**21*`
   จากเครื่องตัวเอง

## Demo script for judges (3 minutes)

1. (0:00) One line: "Every unknown call is answered by AI before it can reach
   you." Show the console.
2. (0:20) Auto-play script 1 (fake police) → red verdict + LINE-style alert.
3. (1:20) Auto-play legit hospital case → green verdict + callback number.
4. (2:00) Freestyle-type a vague line → yellow UNSURE, owner decides.
5. (2:30) Show `/api/calls` tape + verdict authority code; close with cost
   (<฿3/call) and the WhatsApp/Zalo adapter plan for JAPAC.
