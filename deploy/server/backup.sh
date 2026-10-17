#!/usr/bin/env bash
# Runs ON the server every night: dump the database, encrypt it, upload it to S3.
# The passphrase is in /opt/seniq/.env and in Parameter Store (/seniq/backup_passphrase).
# The bucket keeps 30 days of backups.
#
# Restore, on any machine with the passphrase and Postgres 15 tools:
#   aws s3 cp s3://<bucket>/backups/<file>.dump.enc - \
#     | openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE \
#     | pg_restore --no-owner --no-privileges -d <database url>
set -euo pipefail
set -a; . /opt/seniq/.env; set +a
cd /opt/seniq/current/deploy
stamp=$(date -u +%Y%m%dT%H%M%SZ)

docker compose --env-file /opt/seniq/.env exec -T postgres pg_dump -U seniq -Fc seniq \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_PASSPHRASE \
  | aws s3 cp - "s3://$BACKUP_BUCKET/backups/seniq-$stamp.dump.enc" --region "$AWS_REGION"
echo "$(date -u +%FT%TZ) backup $stamp uploaded"
