#!/bin/sh
# Deploy the lean Krai-a demo to Cloud Run. Usage:
#   PROJECT_ID=my-proj REGION=asia-southeast1 ./deploy-demo.sh
set -eu
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-asia-southeast1}"
SERVICE="krai-a-demo"
gcloud config set project "$PROJECT_ID" >/dev/null
gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com >/dev/null
gcloud secrets describe gemini-api-key >/dev/null 2>&1 \
  || (echo "missing secret gemini-api-key — create it first:"; echo "  echo -n '<key>' | gcloud secrets create gemini-api-key --data-file=-"; exit 1)
gcloud run deploy "$SERVICE" --source app \
  --region "$REGION" --allow-unauthenticated \
  --memory 512Mi --min-instances 0 --max-instances 3 \
  --update-secrets "GEMINI_API_KEY=gemini-api-key:latest" --quiet
echo "demo URL:"
gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)'
