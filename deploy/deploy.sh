#!/usr/bin/env bash
# Put SenIQ v1 online on AWS, or update it. Run from the project folder on your computer:
#
#   AWS_PROFILE=seniq COPY_DB=1 ALERT_EMAIL=you@example.com deploy/deploy.sh    # first time
#   AWS_PROFILE=seniq deploy/deploy.sh                                          # every update
#   deploy/deploy.sh --settings        # only list the setting names it would send; no AWS call
#
# What it ships is the last commit (REF, default HEAD), not uncommitted edits.
# Settings: API keys from your local .env (the names in CARRY below), switches from
# deploy/switches.env. Both go to AWS Parameter Store encrypted; the server reads them there.
# COPY_DB=1 copies your local database to the server once, into an empty database only.
# Safe to run again: the first run creates the server; later runs ship the latest commit.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${AWS_REGION:=ap-south-1}"                    # Mumbai
: "${EXPECTED_ACCOUNT:=914800440621}"             # the account that held the IBS categorizer
: "${INSTANCE_TYPE:=t4g.medium}"
: "${REF:=HEAD}"
: "${COPY_DB:=0}"
: "${ALERT_EMAIL:=}"                              # cost alerts; empty = none
: "${MONTHLY_BUDGET_USD:=30}"                     # expected spend is about $23
STACK=seniq
export AWS_REGION AWS_DEFAULT_REGION=$AWS_REGION

[ -f .env ] || { echo "!! No .env in the project folder: the API keys come from it."; exit 1; }

# ── The app's settings, built here from .env and switches.env (nothing is sent yet) ──
# API keys and other values taken from your local .env. Nothing else of it is sent.
CARRY="FINNHUB_API_KEY FMP_API_KEY AIROUTER_API_KEY AIROUTER_MODEL ANTHROPIC_API_KEY CONGRESS_TRADES_URL
NSE_USER_AGENT SEC_USER_AGENT CONTACT_EMAIL HF_API_TOKEN SENTRY_DSN ADMIN_EMAIL ADMIN_PASSWORD
GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET REDDIT_CLIENT_ID
REDDIT_CLIENT_SECRET UPSTOX_ANALYTICS_TOKEN DISCLOSURES"
EMAIL_KEYS="SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS EMAIL_FROM RESEND_API_KEY"
local_value() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -E "s/^[\"'](.*)[\"']$/\1/"; }
switch() { grep -E "^$1=" deploy/switches.env | tail -1 | cut -d= -f2-; }
APP_ENV_FILE=$(mktemp); trap 'rm -f "$APP_ENV_FILE"' EXIT
emit() {
  case $2 in *"'"*) echo "!! $1 contains a single quote; it cannot be passed safely"; exit 1 ;; esac
  [ -n "$2" ] && printf "%s='%s'\n" "$1" "$2" >> "$APP_ENV_FILE"
  return 0
}
KEYS=$CARRY; [ "$(switch ENABLE_EMAIL)" = 1 ] && KEYS="$KEYS $EMAIL_KEYS"
for k in $KEYS; do emit "$k" "$(local_value "$k")"; done
# SEC asks every caller for a contact address.
grep -q '^SEC_USER_AGENT=' "$APP_ENV_FILE" || emit SEC_USER_AGENT "SenIQ $(local_value CONTACT_EMAIL)"
grep -vE '^\s*(#|$)' deploy/switches.env | grep -vE '^(ENABLE_EMAIL|OLLAMA_URL)=' | while IFS='=' read -r k v; do emit "$k" "$v"; done
if [ -n "$(switch OLLAMA_URL)" ]; then
  emit OLLAMA_URL "$(switch OLLAMA_URL)"
  emit COMPANY_SENTIMENT_LLM ollama
  emit COMPANY_SENTIMENT_SCOPE shared
  emit OLLAMA_MODEL qwen2.5:7b-instruct-q4_0
fi
if [ "${1:-}" = --settings ]; then
  echo "Settings that would be sent (names only): $(cut -d= -f1 "$APP_ENV_FILE" | tr '\n' ' ')"; exit 0
fi

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "==> AWS account $ACCOUNT, region $AWS_REGION, profile ${AWS_PROFILE:-default}"
if [ "$ACCOUNT" != "$EXPECTED_ACCOUNT" ]; then
  echo "!! This is not account $EXPECTED_ACCOUNT. Stopping (set EXPECTED_ACCOUNT to deploy elsewhere)."; exit 1
fi
git diff --quiet HEAD -- . ':!deploy/switches.env' || echo "    note: uncommitted changes are NOT shipped; the release is $(git rev-parse --short "$REF")"

if [ -n "$ALERT_EMAIL" ]; then
  echo "==> Cost alerts for $ALERT_EMAIL"
  deploy/aws/cost-alerts.sh "$ALERT_EMAIL" "$MONTHLY_BUDGET_USD"
fi

echo "==> Creating / updating the server (a few minutes the first time)"
aws cloudformation deploy --stack-name $STACK --template-file deploy/aws/seniq.yaml \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides InstanceType="$INSTANCE_TYPE"

out() { aws cloudformation describe-stacks --stack-name $STACK --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
INSTANCE=$(out InstanceId); IP=$(out PublicIp); BUCKET=$(out BucketName)
# A free address that points at the server, with no account: 1-2-3-4.sslip.io → 1.2.3.4.
: "${SITE_DOMAIN:=${IP//./-}.sslip.io}"

echo "==> The app's settings → Parameter Store (encrypted)"
TIER=Standard; [ "$(wc -c < "$APP_ENV_FILE")" -gt 4000 ] && TIER=Advanced
aws ssm put-parameter --name /seniq/app_env --type SecureString --tier $TIER --overwrite \
  --value "file://$APP_ENV_FILE" >/dev/null
echo "    $(grep -c . "$APP_ENV_FILE") settings: $(cut -d= -f1 "$APP_ENV_FILE" | tr '\n' ' ')"

SEED_KEY=none
if [ "$COPY_DB" = 1 ]; then
  echo "==> Copying your local database to the bucket (loaded only into an empty database)"
  LOCAL_DB=$(local_value DATABASE_URL); LOCAL_DB=${LOCAL_DB:-seniq}
  SEED_KEY="seed/seniq-dev-$(date -u +%Y%m%dT%H%M%SZ).dump"
  pg_dump -Fc --no-owner --no-privileges -d "$LOCAL_DB" | aws s3 cp --quiet - "s3://$BUCKET/$SEED_KEY"
  echo "    s3://$BUCKET/$SEED_KEY"
fi

echo "==> Uploading release $(git rev-parse --short "$REF")"
RELEASE=$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short "$REF")
git archive --format=tar.gz -o "/tmp/seniq-$RELEASE.tgz" "$REF"
aws s3 cp --quiet "/tmp/seniq-$RELEASE.tgz" "s3://$BUCKET/releases/seniq-$RELEASE.tgz"
rm "/tmp/seniq-$RELEASE.tgz"

echo "==> Waiting for the server to accept commands"
until [ "$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)" = "Online" ]; do sleep 10; done

echo "==> Building and starting on the server (5-15 minutes the first time)"
COMMANDS=$(cat <<JSON
{"commands":[
  "set -euo pipefail",
  "until [ -f /opt/seniq/.server-ready ]; do sleep 5; done",
  "mkdir -p /opt/seniq/releases/$RELEASE",
  "aws s3 cp --quiet s3://$BUCKET/releases/seniq-$RELEASE.tgz /tmp/release.tgz --region $AWS_REGION",
  "tar -xzf /tmp/release.tgz -C /opt/seniq/releases/$RELEASE && rm /tmp/release.tgz",
  "chmod +x /opt/seniq/releases/$RELEASE/deploy/server/*.sh",
  "ln -sfn /opt/seniq/releases/$RELEASE /opt/seniq/current",
  "/opt/seniq/current/deploy/server/install.sh $SITE_DOMAIN $AWS_REGION $BUCKET $SEED_KEY",
  "ls -1dt /opt/seniq/releases/* | tail -n +4 | xargs -r rm -rf"
]}
JSON
)
CMD=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --timeout-seconds 3600 --parameters "$COMMANDS" --query Command.CommandId --output text)
while :; do
  STATUS=$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  case $STATUS in Success|Failed|Cancelled|TimedOut) break ;; esac
  sleep 15
done
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query StandardOutputContent --output text | tail -20
if [ "$STATUS" != Success ]; then
  aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query StandardErrorContent --output text | tail -40
  echo "!! The server step ended with: $STATUS"; exit 1
fi

cat <<DONE

==> Done.
    Site:    https://$SITE_DOMAIN/app   (the certificate arrives a minute or two after the first start)
    Health:  https://$SITE_DOMAIN/api/health
    Server:  $INSTANCE at $IP
    Logs:    deploy/remote.sh logs
DONE
