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

## LINE Login + LIFF setup (alerts inside LINE)

App flow: member opens the LIFF page inside LINE -> LINE Login verifies the ID token ->
if the LINE id is unknown the page asks for phone OTP first, then binds it to that
phone account (POST /me/link-line). Next opens log straight in.

Steps the USER must do in the LINE Developers Console (https://developers.line.biz/console/):

1. Create a Provider (or reuse one) -> create a **LINE Login** channel (must be
   LINE Login type, not Messaging API — only Login channels mint ID tokens).
2. Channel **App settings** tab: copy the **Channel ID** -> env LINE_LOGIN_CHANNEL_ID.
3. Same tab -> **Linked LIFF app** -> Add -> new LIFF app: Size **Full**,
   Endpoint URL https://<your-host>/liff.html, Scopes **profile** + **openid**.
   Copy the **LIFF ID** (<digits>-<id>) -> env LINE_LIFF_ID.
4. For push alerts (optional): create/use a **Messaging API** channel, copy its
   Channel access token -> LINE_CHANNEL_ACCESS_TOKEN and Channel secret ->
   LINE_CHANNEL_SECRET; set NOTIFY_ADAPTERS=console,line.
5. Redeploy / restart with the env set, then open the LIFF URL inside LINE to test:
   first open asks phone OTP and links; later opens skip straight to settings.

Env vars (see .env.example): LINE_LOGIN_CHANNEL_ID, LINE_LIFF_ID,
LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, LINE_DEFAULT_TO (push only).

## Deploy (live: https://krai-a.com, Google Cloud Run)

```sh
PROJECT_ID=krai-a REGION=asia-southeast1 ./deploy-cloudrun.sh   # from repo root (needs gcloud)
```

One Cloud Run service: marketing site + member app + Twilio voice webhooks
+ demo API. Secrets come from Secret Manager (see script header); public
config via `--set-env-vars`. Scales to zero — first hit after idle takes a
few seconds (cold start), Firestore snapshots preserve state.

## Pages

| Path | Purpose |
|---|---|
| `/` | landing + live verdict widget + forwarding simulator |
| `/features.html`, `/how-it-works.html`, `/family.html`, `/pricing.html` | sales pages (Family = 2 protected numbers) |
| `/start.html` | signup/login via phone OTP (`?plan=` preselects tier) |
| `/dashboard.html` | member app (plan, usage, family numbers, LINE, tapes, whitelist, watchers, cancel) |
| `/demo.html` | judge live-call console (5 scenarios + AI-number banner) |
| `/stats.html` | public trust stats (live counters + method notes) |

## Plans (trial-first, USD + Thai PPP)

| Plan | USD (EN) | THB PPP (TH) | Min/mo | Calls/mo | Protected | Watchers | Tapes |
|---|---|---|---|---|---|---|---|
| Starter | $2 | ฿20 (−71%) | 10 | 5 | 1 | 0 | — |
| Plus | $6 | ฿100 (−52%) | 50 | 25 | 1 | 0 | ✓ |
| Family | $8 | ฿149 (−47%) | 50 | 25 | 2 | 2 | ✓ |

Extra Family seat: +฿69/mo (+1 protected number, +50 min, +25 calls, pooled).
Max 5 seats per household — beyond that, start a new household.

EN mode shows USD global prices; TH mode shows PPP-adjusted baht (≈$1=฿35).
Every plan starts with a free 7-day trial, no card. Cancel anytime in two
layers: dial `##21#` to stop forwarding, then cancel in the dashboard.

AI numbers are always Thai (`02-100-01xx` in demo, real Thai numbers via
Twilio in production) — forwarding stays domestic, never IDD.

Sessions are browser-locked: OTP login issues a token kept in `localStorage`
(30 days). No passwords yet.

## Quota + topup + auto-billing

Quota pools per household: plan minutes + paid seats (+50 each) + topup
packs. `minutesUsed` resets on the 1st of each month (UTC); topup minutes
never expire or reset. Every call burn goes through `consumeMinutes()`
(demo, force-end, and Twilio paths), and `GET /api/me/quota` returns the
full meter (`remaining/used/resetAt`, calls, packs, auto-topup flags).

Topup packs (one-time Stripe Checkout, `kind: 'topup'`): small +10 min
(฿29/$2), medium +30 min (฿69/$5). The webhook grants `topupMinutes`
idempotently (same fulfilled-session set as plans/seats).

Auto-billing split (by payment method — Stripe limitation, not our rule):

- **Card** members with a saved customer: `POST /me/auto-topup`
  `{enabled, threshold 1–30, pack}` arms auto-charge; when remaining ≤
  threshold, `POST /api/billing/auto-topup/charge` (LIFF button/cron)
  creates an off-session PaymentIntent, and `payment_intent.succeeded`
  grants the pack. `quota.autoTopup.due === true` means "charge now".
- **PromptPay** members (and anyone without a saved card) can never be
  charged off-session — Stripe does not support it. They get
  `manualPrompt === true` and the LIFF meter shows the manual top-up
  button instead. No silent failure: the toggle saves, the prompt shows.

Card saving (so auto-charge works end-to-end): card checkouts set
`payment_intent_data[setup_future_usage]=off_session` and reuse the known
Stripe customer, or `customer_creation=always` for first-time payers (the
webhook stamps `session.customer` onto the member). The PromptPay-only
checkout (Starter ฿20 TH) sets neither — Stripe rejects off-session setup
on PromptPay. Off-session charges pass the newest saved card id
explicitly (Stripe's no-`payment_method` fallback is the legacy
`default_source`, which Checkout never sets).

Buying from the UI: the dashboard plan card has a Pay button
(`kind: 'plan'`), the extra-number flow opens a seat Checkout instead of
a dead end, and both the dashboard usage card and LIFF sell topup packs
with the auto-topup toggle + charge-now button — all return to `?paid=1`
with a confirmation banner. Past quota, protection never cuts: the owner gets
one quota-low alert per billing period (every call-end path calls
`maybeNotifyQuotaLow()` after burning minutes) with a top-up nudge.

## Trust stats (brag-gated counters)

`src/stats.js` keeps monotonic counters fed by `endCall()` (real calls only —
demo sessions never count) and `addMember()` (seed fixture excluded). Counters
live apart from call records, so PDPA retention purges never shrink them, and
they ride the Firestore snapshot (`stats` key; legacy snapshots backfill once
from restored calls).

`GET /api/stats` returns aggregate-only figures for the landing strip and
`/stats.html`. Each metric carries a `shown` flag: below its minimum the
frontend hides it entirely, above it the figure floors to a round tier and
renders with "กว่า/X+". Current minimums (`STATS_MIN`): calls 100, scams 50,
legit 50, minutes 500, households 50; the scam-rate ratio shows once the call
base clears 100.

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
| GET | `/api/me/quota` | quota meter: remaining/used/reset + packs (auth) |
| POST | `/api/me/auto-topup` | auto-billing toggle `{enabled, threshold?, pack?}` (auth) |
| POST | `/api/billing/checkout` | Stripe Checkout: plan/seat/topup `{kind, plan?, pack?, region?, from?}` (auth) |
| POST | `/api/billing/auto-topup/charge` | charge-now when quota low (auth) |
| POST | `/api/billing/webhook` | Stripe events: `checkout.session.completed`, `payment_intent.succeeded` |
| GET | `/api/plans` | plan catalog + trial days |
| POST | `/api/me/plan` | switch plan `{plan}` (auth) |
| GET/POST | `/api/me/numbers` | protected numbers, plan-capped (auth) |
| POST | `/api/me/notify` | link/unlink LINE `{lineUserId}` (auth, optional) |
| POST | `/api/me/link-line` | bind this LINE id to own phone account `{idToken}` (auth; 409 if taken) |
| POST | `/api/auth/line-verify` | LIFF login `{idToken}` -> session, or `{needsLink:true}` |
| POST | `/api/me/cancel`, `/api/me/reactivate` | cancel / resume membership (auth) |
| GET | `/api/status` | engine / mode / adapters |
| GET | `/api/stats` | public trust stats (aggregate-only, brag-gated) |
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
