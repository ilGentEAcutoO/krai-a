#!/usr/bin/env bash
# Deploy Krai-A to Cloud Run: new image + TARGETED env/secret updates. Every
# other live env var is kept (never --set-env-vars: it replaces the whole env).
# One codebase, two roles (SITE_MODE, see app/src/siteMode.js):
#   SERVICE=krai-a      SITE_MODE=product  -> https://krai-a.com       business app: every secret
#   SERVICE=krai-a-demo SITE_MODE=demo     -> https://demo.krai-a.com  hackathon site: Gemini/Jev/Firestore only
# Any other SERVICE/SITE_MODE pair is refused unless ROLE_OVERRIDE=1.
# Demo mode REMOVES every business secret/env from the service.
# Each role runs as its own least-privilege service account (never the
# default compute SA, which holds roles/editor): krai-a-run reads the business
# secrets + Firestore (default) only; krai-a-demo-run reads Gemini/Jev/reCAPTCHA
# + Firestore database "hackathon" only, so the public site cannot reach member
# data even if its code is compromised.
# Usage (repo root; needs gcloud + curl):
#   SERVICE=krai-a SITE_MODE=product PROJECT_ID=krai-a ./deploy-cloudrun.sh
#   DRY_RUN=1 SERVICE=krai-a-demo SITE_MODE=demo PROJECT_ID=krai-a ./deploy-cloudrun.sh   # print every command, run none
#   JUDGING=1 ...   # judging window: 1 warm instance, CPU always on (extra cost)
# Optional overrides: REGION, SRC_DIR (default app; the public repo tree for the
# hackathon role), PUBLIC_BASE_URL (default = the service's domain mapping),
# PRODUCT_BASE_URL (demo mode: where product pages redirect), PERSIST_DOC
# (default = the role's own Firestore doc), PERSIST_DATABASE (default: demo
# "hackathon", product "(default)"), RUN_SA (default: the role's service
# account), LIVE_MAX_SECONDS /
# LIVE_MAX_PER_IP_HOUR / LIVE_MAX_PER_DAY, RECAPTCHA_PROJECT_ID.
# Exported RECAPTCHA_SITE_KEY / LINE_DEFAULT_TO / TWILIO_ACCOUNT_SID /
# TWILIO_VERIFY_SID / CENTRAL_NUMBER_TH are applied (demo mode takes only
# RECAPTCHA_SITE_KEY); unset ones keep their live value, or are filled from
# COPY_ENV_FROM=<saved `gcloud run services describe --format=json`>.
# Secrets come from Secret Manager only — this script never reads or prints a value.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-asia-southeast1}"
SERVICE="${SERVICE:?set SERVICE (krai-a = business, krai-a-demo = hackathon)}"
SITE_MODE="${SITE_MODE:?set SITE_MODE (demo|product)}"
case "$SITE_MODE" in demo|product) ;; *) echo "SITE_MODE must be demo or product" >&2; exit 2 ;; esac
case "$SERVICE" in
  krai-a) ROLE=product; DOMAIN=https://krai-a.com ;;
  krai-a-demo) ROLE=demo; DOMAIN=https://demo.krai-a.com ;;
  *) ROLE=""; DOMAIN="" ;;
esac
if [ "$SITE_MODE" != "$ROLE" ] && [ "${ROLE_OVERRIDE:-0}" != 1 ]; then
  echo "refusing: $SERVICE serves the ${ROLE:-unknown} role, not $SITE_MODE (ROLE_OVERRIDE=1 to force)" >&2; exit 2
fi
REPO="krai-a"
SRC_DIR="${SRC_DIR:-app}"
# LIVE_RECORD_DIR is the local-only live-session recorder (PDPA): it must never
# reach Cloud Run, so its presence in this shell or the tree's .env stops the deploy.
if [ -n "${LIVE_RECORD_DIR:-}" ] || { [ -f "$SRC_DIR/.env" ] && grep -qE '^[[:space:]]*(export[[:space:]]+)?LIVE_RECORD_DIR=[^[:space:]#]' "$SRC_DIR/.env"; }; then
  echo "refusing: LIVE_RECORD_DIR is a local-only recorder" >&2; exit 1
fi
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/krai-a:$SITE_MODE"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-$DOMAIN}"
[ -n "$PUBLIC_BASE_URL" ] || { echo "set PUBLIC_BASE_URL for an unmapped service" >&2; exit 2; }
PRODUCT_BASE_URL="${PRODUCT_BASE_URL:-https://krai-a.com}"
DRY_RUN="${DRY_RUN:-0}"
JUDGING="${JUDGING:-0}"
if [ "$SITE_MODE" = demo ]; then
  RUN_SA="${RUN_SA:-krai-a-demo-run@$PROJECT_ID.iam.gserviceaccount.com}"
  PERSIST_DATABASE="${PERSIST_DATABASE:-hackathon}"
else
  RUN_SA="${RUN_SA:-krai-a-run@$PROJECT_ID.iam.gserviceaccount.com}"
  PERSIST_DATABASE="${PERSIST_DATABASE:-}"
fi

say() { printf '%s\n' "$*"; }
# show: print a command so it can be pasted back into a shell.
show() {
  local a out='+'
  for a in "$@"; do
    if [[ "$a" =~ ^[A-Za-z0-9_./:=@%+,^-]+$ ]]; then out+=" $a"; else out+=" '${a//\'/\'\\\'\'}'"; fi
  done
  printf '%s\n' "$out"
}
# run: execute, or under DRY_RUN only print the command.
run() { if [ "$DRY_RUN" = 1 ]; then show "$@"; else "$@"; fi; }
# query: a read-only command whose output we need. DRY_RUN prints the command
# (to stderr) and returns the placeholder instead.
query() {
  local placeholder="$1"; shift
  if [ "$DRY_RUN" = 1 ]; then show "$@" >&2; printf '%s' "$placeholder"; else "$@"; fi
}
exists() { # read-only existence check; DRY_RUN assumes present unless the
  # last argument is listed in DRY_RUN_ABSENT (space-separated, for tests)
  if [ "$DRY_RUN" = 1 ]; then show "$@"; [[ " ${DRY_RUN_ABSENT:-} " != *" ${!#} "* ]]; return; fi
  "$@" >/dev/null 2>&1
}

[ "$DRY_RUN" = 1 ] && say "== DRY RUN: printing commands, nothing is executed =="
say "service: $SERVICE  site mode: $SITE_MODE  public: $PUBLIC_BASE_URL  image: $IMAGE  source: $SRC_DIR"
say "runs as: $RUN_SA  firestore database: ${PERSIST_DATABASE:-(default)}"

run gcloud config set project "$PROJECT_ID"
run gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
exists gcloud artifacts repositories describe "$REPO" --location="$REGION" \
  || run gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION"

# ---- secrets: env var = secret:latest. kind "key" = pasted API key/token,
# "random" = generate it. Required ones must exist before deploy (the revision
# would fail); an "optional" one is left out with a WARN when it is missing.
# The hackathon role holds only what the demo spends: Gemini, Jev, reCAPTCHA.
SECRETS=(
  "GEMINI_API_KEY gemini-api-key key"
  "TYPESAFE_API_KEY typesafe-api-key key optional Jev disabled in prod — /api/status will be 'degraded'"
)
PRODUCT_SECRETS=(
  "THSMS_API_KEY thsms-api-key key"
  "LINE_CHANNEL_ACCESS_TOKEN line-channel-token key"
  "LINE_CHANNEL_SECRET krai-a-line-secret key"
  "TWILIO_AUTH_TOKEN twilio-auth-token key"
  "TRIAL_TOMBSTONE_SECRET trial-tombstone-secret random"
  "STRIPE_SECRET_KEY stripe-secret-key key optional Stripe checkout off"
  "STRIPE_WEBHOOK_SECRET stripe-webhook-secret key optional Stripe webhook off"
)
# Business env taken off a demo-mode service (it may have been product before).
PRODUCT_ENV="LINE_DEFAULT_TO,LINE_LOGIN_CHANNEL_ID,LINE_LIFF_ID,TWILIO_ACCOUNT_SID,TWILIO_VERIFY_SID,CENTRAL_NUMBER_TH,THSMS_SENDER"
remove_secrets=()
if [ "$SITE_MODE" = product ]; then
  SECRETS+=("${PRODUCT_SECRETS[@]}")
else
  for row in "${PRODUCT_SECRETS[@]}"; do read -r env _ <<<"$row"; remove_secrets+=("$env"); done
fi
missing=0
secret_args=()
for row in "${SECRETS[@]}"; do
  read -r env name kind need why <<<"$row"
  if exists gcloud secrets describe "$name"; then
    secret_args+=("$env=$name:latest")
  else
    if [ "${need:-}" = optional ]; then
      say "WARN missing optional secret: $name — $env not set. $why"
      say "  (to enable it later, create it once and re-run):"
    else
      missing=1
      say "missing secret: $name  (create it once, then re-run):"
    fi
    if [ "$kind" = random ]; then
      say "  openssl rand -hex 32 | tr -d '\\r\\n' | gcloud secrets create $name --data-file=-"
    else
      say "  read -rs VALUE && printf %s \"\$VALUE\" | gcloud secrets create $name --data-file=- && unset VALUE"
    fi
    say "  gcloud secrets add-iam-policy-binding $name --role=roles/secretmanager.secretAccessor --member=serviceAccount:$RUN_SA"
  fi
done
# reCAPTCHA server key is optional (absent = bot gate off). Both roles: it guards live talk.
if exists gcloud secrets describe recaptcha-api-key; then secret_args+=("RECAPTCHA_API_KEY=recaptcha-api-key:latest"); fi
[ "$missing" = 1 ] && { say "aborting: create the missing secrets first"; exit 1; }

# ---- runtime identity + data isolation: the role's SA and database must exist ----
if ! exists gcloud iam service-accounts describe "$RUN_SA"; then
  say "missing service account: $RUN_SA (create it once, grant secretAccessor per secret above and"
  say "  roles/datastore.user with an IAM condition on its Firestore database only; never a project-wide role)"
  exit 1
fi
if [ -n "$PERSIST_DATABASE" ] && [ "$PERSIST_DATABASE" != "(default)" ] \
  && ! exists gcloud firestore databases describe --database="$PERSIST_DATABASE"; then
  say "missing Firestore database: $PERSIST_DATABASE"
  say "  gcloud firestore databases create --database=$PERSIST_DATABASE --location=$REGION --type=firestore-native"
  exit 1
fi

# ---- plain env: decided values + optional pass-through (never secrets) ----
env_args=(
  "SITE_MODE=$SITE_MODE"
  "IDENTIFY_MODE=B"
  "GEMINI_MODEL=gemini-3.5-flash-lite"
  "DEMO_TEXT_API=0"
  "PUBLIC_BASE_URL=$PUBLIC_BASE_URL"
  "RECAPTCHA_PROJECT_ID=${RECAPTCHA_PROJECT_ID:-krai-a}"
  "LIVE_MAX_SECONDS=${LIVE_MAX_SECONDS:-120}"
  "LIVE_MAX_PER_IP_HOUR=${LIVE_MAX_PER_IP_HOUR:-3}"
  "LIVE_MAX_PER_DAY=${LIVE_MAX_PER_DAY:-300}"
)
remove_env="AI_OFFLINE,AI_LIVE_TESTS,GEMINI_PERSONA_MODEL,LIVE_RECORD_DIR"
if [ -n "${PERSIST_DOC:-}" ]; then env_args+=("PERSIST_DOC=$PERSIST_DOC"); else remove_env+=",PERSIST_DOC"; fi
if [ -n "$PERSIST_DATABASE" ]; then env_args+=("PERSIST_DATABASE=$PERSIST_DATABASE"); else remove_env+=",PERSIST_DATABASE"; fi
if [ "$SITE_MODE" = product ]; then
  env_args+=("NOTIFY_ADAPTERS=console,line" "LINE_LOGIN_CHANNEL_ID=2008922436")
  pass=(RECAPTCHA_SITE_KEY LINE_DEFAULT_TO TWILIO_ACCOUNT_SID TWILIO_VERIFY_SID CENTRAL_NUMBER_TH)
else
  env_args+=("NOTIFY_ADAPTERS=console" "PRODUCT_BASE_URL=$PRODUCT_BASE_URL")
  pass=(RECAPTCHA_SITE_KEY)
  remove_env+=",$PRODUCT_ENV"
fi
# COPY_ENV_FROM: fill unset pass-through values from a saved service describe
# (names are reported, values never printed).
from_copy() {
  [ -n "${COPY_ENV_FROM:-}" ] && [ -f "$COPY_ENV_FROM" ] || return 0
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const e=(d.spec.template.spec.containers[0].env||[]).find(x=>x.name===process.argv[2]&&"value" in x);process.stdout.write(e?e.value:"")' "$COPY_ENV_FROM" "$1"
}
copied=()
for v in "${pass[@]}"; do
  val="${!v:-}"
  if [ -z "$val" ]; then val="$(from_copy "$v")"; [ -n "$val" ] && copied+=("$v"); fi
  if [ -n "$val" ]; then env_args+=("$v=$val"); fi
done
if [ -n "${COPY_ENV_FROM:-}" ]; then say "env copied from $COPY_ENV_FROM: ${copied[*]:-none}"; fi
join() { local IFS="$1"; shift; printf '%s' "$*"; }

# One instance: snapshots, rate limits, turn locks and live sessions are
# in-memory. Affinity keeps /ws/live on it; 900 s outlives 120 s live calls.
scale_args=(--max-instances 1 --session-affinity --timeout 900)
if [ "$JUDGING" = 1 ]; then
  scale_args+=(--min-instances 1 --no-cpu-throttling) # no cold start; 15 s snapshots keep running
else
  scale_args+=(--min-instances 0 --cpu-throttling)
fi

# Demo mode: business secrets come OFF the service (never left attached).
secret_flags=()
if [ "${#remove_secrets[@]}" -gt 0 ]; then secret_flags+=(--remove-secrets "$(join ',' "${remove_secrets[@]}")"); fi
secret_flags+=(--update-secrets "$(join ',' "${secret_args[@]}")")

PREV=$(query "$SERVICE-00000-dry" gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.latestReadyRevisionName)')
say "current revision (rollback target): $PREV"

run gcloud builds submit "$SRC_DIR" --tag "$IMAGE" --quiet
run gcloud run deploy "$SERVICE" \
  --image "$IMAGE" --region "$REGION" --platform managed --allow-unauthenticated --memory 512Mi \
  --service-account "$RUN_SA" \
  "${scale_args[@]}" \
  --update-env-vars "^;^$(join ';' "${env_args[@]}")" \
  --remove-env-vars "$remove_env" \
  "${secret_flags[@]}" \
  --quiet

URL=$(query "https://$SERVICE-dry.a.run.app" gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')
ROLLBACK="gcloud run services update-traffic $SERVICE --region $REGION --to-revisions=$PREV=100"
say "live: $URL"
say "rollback: $ROLLBACK"

# ---- smoke: engine up, no member feed, the role's pages, CSP header ----
fail=0
check() { # label, expected, actual
  if [ "$2" = "$3" ]; then say "  ok   $1"; else say "  FAIL $1 (expected $2, got $3)"; fail=1; fi
}
code() { query "${2:-200}" curl -s -o /dev/null -w '%{http_code}' "${@:3}" "$1"; }
say "smoke test:"
mode=$(query '"mode":"live"' curl -fsS "$URL/api/status" | grep -o '"mode":"[a-z]*"' | head -1 || true)
case "$mode" in
  *live*) say "  ok   engine mode live" ;;
  *degraded*) say "  WARN engine mode degraded (Jev or Gemini down/unset — check /api/status engineStatus)" ;;
  *) say "  FAIL engine mode: ${mode:-no answer}"; fail=1 ;;
esac
check "/api/members is gone" 404 "$(code "$URL/api/members" 404)"
check "/demo.html" 200 "$(code "$URL/demo.html")"
csp=$(query 'content-security-policy: dry' curl -sSI "$URL/" | grep -i '^content-security-policy:' || true)
if [ -n "$csp" ]; then say "  ok   content-security-policy header"; else say "  FAIL content-security-policy header missing"; fail=1; fi
if [ "$SITE_MODE" = demo ]; then
  check "demo: /api/me is 404" 404 "$(code "$URL/api/me" 404)"
  check "demo: /api/plans is 404" 404 "$(code "$URL/api/plans" 404)"
  check "demo: POST /voice/incoming is 404" 404 "$(code "$URL/voice/incoming" 404 -X POST -d '')"
  check "demo: POST /line/webhook is 404" 404 "$(code "$URL/line/webhook" 404 -X POST -d '')"
  check "demo: /pricing.html -> business host" 302 "$(code "$URL/pricing.html" 302)"
else
  check "product: /api/plans" 200 "$(code "$URL/api/plans")"
  check "product: /pricing.html" 200 "$(code "$URL/pricing.html")"
fi
check "$PUBLIC_BASE_URL/ (domain mapping)" 200 "$(code "$PUBLIC_BASE_URL/")"

say "after deploy: check logs for '[csp]', '[persist]' and 'bad twilio signature' lines"
if [ "$SITE_MODE" = product ]; then
  say "Twilio number: Voice webhook POST $PUBLIC_BASE_URL/voice/incoming, Call status changes POST $PUBLIC_BASE_URL/voice/status"
  say "LINE: Messaging API webhook $PUBLIC_BASE_URL/line/webhook, LIFF endpoint $PUBLIC_BASE_URL/liff.html; Stripe webhook $PUBLIC_BASE_URL/api/billing/webhook"
fi
if [ "$fail" = 1 ]; then say "SMOKE FAILED — roll back with: $ROLLBACK"; exit 1; fi
say "deploy ok"
