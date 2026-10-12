#!/usr/bin/env bash
# Deploy Krai-A to Cloud Run: new image + TARGETED env/secret updates. Every
# other live env var is kept (never --set-env-vars: it replaces the whole env).
# Usage (repo root; needs gcloud + curl):
#   PROJECT_ID=krai-a ./deploy-cloudrun.sh             # deploy
#   DRY_RUN=1 PROJECT_ID=krai-a ./deploy-cloudrun.sh   # print every command, run none
#   JUDGING=1 PROJECT_ID=krai-a ./deploy-cloudrun.sh   # judging window: 1 warm instance, CPU always on (extra cost)
# Optional overrides: REGION, PUBLIC_BASE_URL (default https://krai-a.com),
# LIVE_MAX_SECONDS / LIVE_MAX_PER_IP_HOUR / LIVE_MAX_PER_DAY, RECAPTCHA_PROJECT_ID.
# Exported RECAPTCHA_SITE_KEY / LINE_DEFAULT_TO / TWILIO_ACCOUNT_SID /
# TWILIO_VERIFY_SID / CENTRAL_NUMBER_TH are applied; unset ones keep their live value.
# Secrets come from Secret Manager only — this script never reads or prints a value.
# Twilio number (once): Voice webhook POST $PUBLIC_BASE_URL/voice/incoming and
# "Call status changes" POST $PUBLIC_BASE_URL/voice/status (see app/README.md).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-asia-southeast1}"
SERVICE="krai-a"
REPO="krai-a"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$SERVICE:latest"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://krai-a.com}"
DRY_RUN="${DRY_RUN:-0}"
JUDGING="${JUDGING:-0}"

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

run gcloud config set project "$PROJECT_ID"
run gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
exists gcloud artifacts repositories describe "$REPO" --location="$REGION" \
  || run gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION"

# ---- secrets: env var = secret:latest. kind "key" = pasted API key/token,
# "random" = generate it. Required ones must exist before deploy (the revision
# would fail); an "optional" one is left out with a WARN when it is missing.
SECRETS=(
  "GEMINI_API_KEY gemini-api-key key"
  "THSMS_API_KEY thsms-api-key key"
  "LINE_CHANNEL_ACCESS_TOKEN line-channel-token key"
  "LINE_CHANNEL_SECRET krai-a-line-secret key"
  "TWILIO_AUTH_TOKEN twilio-auth-token key"
  "TYPESAFE_API_KEY typesafe-api-key key optional Jev disabled in prod — /api/status will be 'degraded'"
  "TRIAL_TOMBSTONE_SECRET trial-tombstone-secret random"
)
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
    say "  gcloud secrets add-iam-policy-binding $name --role=roles/secretmanager.secretAccessor \\"
    say "    --member=\"serviceAccount:\$(gcloud run services describe $SERVICE --region $REGION --format='value(spec.template.spec.serviceAccountName)')\""
    say "    (empty service account = the default: PROJECT_NUMBER-compute@developer.gserviceaccount.com)"
  fi
done
# reCAPTCHA server key is optional (absent = bot gate off).
if exists gcloud secrets describe recaptcha-api-key; then secret_args+=("RECAPTCHA_API_KEY=recaptcha-api-key:latest"); fi
[ "$missing" = 1 ] && { say "aborting: create the missing secrets first"; exit 1; }

# ---- plain env: decided values + optional pass-through (never secrets) ----
env_args=(
  "IDENTIFY_MODE=B"
  "GEMINI_MODEL=gemini-3.5-flash-lite"
  "DEMO_TEXT_API=0"
  "PUBLIC_BASE_URL=$PUBLIC_BASE_URL"
  "NOTIFY_ADAPTERS=console,line"
  "LINE_LOGIN_CHANNEL_ID=2008922436"
  "RECAPTCHA_PROJECT_ID=${RECAPTCHA_PROJECT_ID:-krai-a}"
  "LIVE_MAX_SECONDS=${LIVE_MAX_SECONDS:-120}"
  "LIVE_MAX_PER_IP_HOUR=${LIVE_MAX_PER_IP_HOUR:-3}"
  "LIVE_MAX_PER_DAY=${LIVE_MAX_PER_DAY:-300}"
)
for v in RECAPTCHA_SITE_KEY LINE_DEFAULT_TO TWILIO_ACCOUNT_SID TWILIO_VERIFY_SID CENTRAL_NUMBER_TH; do
  [ -n "${!v:-}" ] && env_args+=("$v=${!v}")
done
join() { local IFS="$1"; shift; printf '%s' "$*"; }

# One instance: snapshots, rate limits, turn locks and live sessions are
# in-memory. Affinity keeps /ws/live on it; 900 s outlives 120 s live calls.
scale_args=(--max-instances 1 --session-affinity --timeout 900)
if [ "$JUDGING" = 1 ]; then
  scale_args+=(--min-instances 1 --no-cpu-throttling) # no cold start; 15 s snapshots keep running
else
  scale_args+=(--min-instances 0 --cpu-throttling)
fi

PREV=$(query "$SERVICE-00000-dry" gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.latestReadyRevisionName)')
say "current revision (rollback target): $PREV"

run gcloud builds submit app --tag "$IMAGE" --quiet
run gcloud run deploy "$SERVICE" \
  --image "$IMAGE" --region "$REGION" --platform managed --allow-unauthenticated --memory 512Mi \
  "${scale_args[@]}" \
  --update-env-vars "^;^$(join ';' "${env_args[@]}")" \
  --remove-env-vars AI_OFFLINE,AI_LIVE_TESTS,GEMINI_PERSONA_MODEL \
  --update-secrets "$(join ',' "${secret_args[@]}")" \
  --quiet

URL=$(query "https://$SERVICE-dry.a.run.app" gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')
ROLLBACK="gcloud run services update-traffic $SERVICE --region $REGION --to-revisions=$PREV=100"
say "live: $URL"
say "rollback: $ROLLBACK"

# ---- smoke: engine up, no member feed, demo page, CSP header ----
fail=0
check() { # label, expected, actual
  if [ "$2" = "$3" ]; then say "  ok   $1"; else say "  FAIL $1 (expected $2, got $3)"; fail=1; fi
}
code() { query "${2:-200}" curl -s -o /dev/null -w '%{http_code}' "$1"; }
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
check "$PUBLIC_BASE_URL/demo.html (domain mapping)" 200 "$(code "$PUBLIC_BASE_URL/demo.html")"

say "after deploy: check logs for '[csp]' and 'bad twilio signature' lines;"
say "Twilio number: Voice webhook POST $PUBLIC_BASE_URL/voice/incoming, Call status changes POST $PUBLIC_BASE_URL/voice/status"
if [ "$fail" = 1 ]; then say "SMOKE FAILED — roll back with: $ROLLBACK"; exit 1; fi
say "deploy ok"
