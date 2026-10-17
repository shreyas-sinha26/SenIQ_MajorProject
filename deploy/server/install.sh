#!/usr/bin/env bash
# Runs ON the server (deploy.sh calls it). First run: creates the database password, the
# session secret and the backup passphrase. Every run: writes the app's settings from
# Parameter Store, copies the dev database in once if asked, rebuilds and restarts.
#
#   install.sh <site address> <aws region> <bucket> <database copy key in the bucket, or "none">
set -euo pipefail

SITE_DOMAIN=$1 REGION=$2 BUCKET=$3 SEED_KEY=${4:-none}
cd "$(dirname "$0")/.."            # the deploy/ folder
ENV_FILE=/opt/seniq/.env           # compose variables; outside the release, so a new release keeps it
APP_ENV=/opt/seniq/app.env         # the app's own settings, rewritten from Parameter Store each run
SEEDED=/opt/seniq/.db-seeded

secret() { openssl rand -hex 32; }
put() { aws ssm put-parameter --region "$REGION" --name "/seniq/$1" --type SecureString --value "$2" --overwrite >/dev/null; }
compose() { docker compose --env-file "$ENV_FILE" "$@"; }

if [ ! -f "$ENV_FILE" ]; then
  echo "first run: creating secrets"
  BACKUP_PASSPHRASE=$(secret)
  umask 077
  cat > "$ENV_FILE" <<ENV
POSTGRES_PASSWORD=$(secret)
JWT_SECRET=$(secret)
BACKUP_PASSPHRASE=$BACKUP_PASSPHRASE
ENV
  # Kept in Parameter Store too, so the backups can still be opened if the server is lost.
  put backup_passphrase "$BACKUP_PASSPHRASE"
fi

set_env() { grep -v "^$1=" "$ENV_FILE" > "$ENV_FILE.tmp" || true; echo "$1=$2" >> "$ENV_FILE.tmp"; mv "$ENV_FILE.tmp" "$ENV_FILE"; }
set_env SITE_DOMAIN "$SITE_DOMAIN"
set_env AWS_REGION "$REGION"
set_env BACKUP_BUCKET "$BUCKET"
chmod 600 "$ENV_FILE"

umask 077
aws ssm get-parameter --region "$REGION" --name /seniq/app_env --with-decryption \
  --query Parameter.Value --output text > "$APP_ENV"
chmod 600 "$APP_ENV"

# The database first, so the dev copy goes in before the app's first start.
compose up -d postgres
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q postgres)")" = healthy ]; do sleep 3; done

if [ "$SEED_KEY" != none ] && [ ! -f "$SEEDED" ]; then
  TABLES=$(compose exec -T postgres psql -U seniq -d seniq -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
  if [ "$TABLES" = 0 ]; then
    echo "copying in the dev database ($SEED_KEY)"
    aws s3 cp --quiet "s3://$BUCKET/$SEED_KEY" - --region "$REGION" \
      | compose exec -T postgres pg_restore -U seniq -d seniq --no-owner --no-privileges --exit-on-error
    touch "$SEEDED"
    echo "dev database copied: $(compose exec -T postgres psql -U seniq -d seniq -tAc 'SELECT count(*) FROM articles') articles, $(compose exec -T postgres psql -U seniq -d seniq -tAc 'SELECT count(*) FROM users') accounts"
  else
    echo "!! the database already has $TABLES tables: the dev copy was NOT loaded over it"
  fi
fi

compose up -d --build --remove-orphans
docker image prune -f >/dev/null

# Nightly encrypted backup at 02:00 India time (20:30 UTC).
cat > /etc/cron.d/seniq-backup <<CRON
30 20 * * * root /opt/seniq/current/deploy/server/backup.sh >> /var/log/seniq-backup.log 2>&1
CRON

compose ps --format 'table {{.Service}}\t{{.Status}}'
