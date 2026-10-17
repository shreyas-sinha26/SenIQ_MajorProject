#!/usr/bin/env bash
# Run a command on the SenIQ server through AWS Systems Manager (no SSH) and print its output.
#
#   AWS_PROFILE=seniq deploy/remote.sh logs              # the app's last 100 log lines
#   AWS_PROFILE=seniq deploy/remote.sh ps                # the containers and their state
#   AWS_PROFILE=seniq deploy/remote.sh backup            # take a backup now
#   AWS_PROFILE=seniq deploy/remote.sh "free -h"         # anything else, as root
set -euo pipefail
: "${AWS_REGION:=ap-south-1}"
export AWS_REGION AWS_DEFAULT_REGION=$AWS_REGION
COMPOSE="cd /opt/seniq/current/deploy && docker compose --env-file /opt/seniq/.env"
case ${1:-ps} in
  logs)   RUN="$COMPOSE logs --tail ${2:-100} app" ;;
  ps)     RUN="$COMPOSE ps --format 'table {{.Service}}\t{{.Status}}'" ;;
  backup) RUN="/opt/seniq/current/deploy/server/backup.sh" ;;
  *)      RUN=$1 ;;
esac
INSTANCE=$(aws cloudformation describe-stacks --stack-name seniq --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)
PARAMS=$(python3 -I -c 'import json,sys; print(json.dumps({"commands": [sys.argv[1]]}))' "$RUN")
CMD=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --parameters "$PARAMS" --query Command.CommandId --output text)
while :; do
  STATUS=$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  case $STATUS in Success|Failed|Cancelled|TimedOut) break ;; esac
  sleep 2
done
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query StandardOutputContent --output text
ERR=$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query StandardErrorContent --output text)
[ -n "$ERR" ] && [ "$ERR" != None ] && echo "$ERR" >&2
[ "$STATUS" = Success ]
