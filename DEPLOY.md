# SenIQ — Deployment (AWS)

SenIQ v1 runs on one EC2 server in Mumbai (`ap-south-1`), in Docker:

```
Browser ──HTTPS──▶ caddy (certificate) ──▶ app (site, API, scheduled jobs, FinBERT) ──▶ postgres
                                                         nightly encrypted backup ──▶ S3
```

Everything is in [`deploy/`](deploy): a CloudFormation template (server, fixed address, security
group with only 80 and 443 open, encrypted bucket, the server's IAM role), the compose file,
and the scripts. The server is managed through AWS Systems Manager, so no SSH port is open.

- **One app container only.** The scheduled jobs run inside the app; a second copy would run
  every job twice.
- **v1 only.** `FEATURES_STRATEGIES` is not set and the strategy engine is not deployed, so the
  v2 routes (`/api/strategies`, `/api/paper`, `/api/keys`, `/mcp`, `/v1`, `/docs`) answer 404.
- Migrations run on every start (`server/db.js`), so a deploy also migrates.

## One-time setup

1. In the AWS account, IAM → Users → create `seniq-deploy` (no console access), attach
   `AdministratorAccess`, then Security credentials → Create access key (Command Line Interface).
2. On your computer, enter the key yourself (it never goes in the repo or a chat):
   ```bash
   aws configure --profile seniq
   ```
   Region `ap-south-1`, output `json`. Check it: `aws sts get-caller-identity --profile seniq`.
3. Docker is not needed on your computer; the image is built on the server. Postgres 15 tools
   (`pg_dump`) are needed once, for the database copy.

## Deploy

First time (copies your local database across, into the empty one on the server):

```bash
AWS_PROFILE=seniq COPY_DB=1 ALERT_EMAIL=you@example.com deploy/deploy.sh
```

Every update after that (ships the last commit, not uncommitted edits):

```bash
AWS_PROFILE=seniq deploy/deploy.sh
```

At the end it prints the address: `https://seniq.<ip-with-dashes>.sslip.io/app`, a free name
that points at the server's fixed IP with no account. Since 2026-10-17 the site uses
**`seniq.duckdns.org`**, a free DuckDNS name set in `deploy/switches.env` (`SITE_DOMAIN`). If
the server's IP ever changes, update it at duckdns.org.

## Settings

- **API keys** come from your local `.env`, only the names listed in `CARRY` in
  `deploy/deploy.sh`. They are stored encrypted in Parameter Store (`/seniq/app_env`) and
  written to `/opt/seniq/app.env` on the server.
- **Switches** are in [`deploy/switches.env`](deploy/switches.env): edit, commit, run
  `deploy.sh` again. `CLAUDE_REPORTS`, `ENABLE_EMAIL` and the listed-news switches start at 0.
- `deploy/deploy.sh --settings` lists the names it would send, without calling AWS.
- The database password, the session secret (`JWT_SECRET`) and the backup passphrase are made
  on the server at the first run (`/opt/seniq/.env`); the passphrase is also in Parameter Store.

## The admin account

`admin@seniq.duckdns.org`, created by the app on start, then moved to the Free plan so it never
calls Claude (the admin tier switcher can preview Plus and Pro). Its password is made at the
first deploy and kept encrypted in Parameter Store:

```bash
aws ssm get-parameter --profile seniq --region ap-south-1 --name /seniq/admin_password --with-decryption --query Parameter.Value --output text
```

## Look at it

```bash
AWS_PROFILE=seniq deploy/remote.sh ps
AWS_PROFILE=seniq deploy/remote.sh logs 200
AWS_PROFILE=seniq deploy/remote.sh backup
```

## Backups

Every night at 02:00 IST: `pg_dump`, encrypted with the passphrase, to
`s3://<bucket>/backups/`, kept 30 days. How to restore is at the top of
[`deploy/server/backup.sh`](deploy/server/backup.sh).

## Cost

The account is on AWS's **Free plan**: usage is paid from its credits ($129 left on
2026-10-17, plan ends 2027-01-31) and nothing is charged to a card. The Free plan allows only
free-tier instance types, so the server is a `t4g.small` (2 GB, with 2 GB of swap);
`t4g.medium` needs the Paid plan.

| Item | A month |
|---|---|
| `t4g.small` server | $8.18 |
| 20 GB gp3 disk | $1.82 |
| Fixed public IP | $3.65 |
| S3 backups and releases, Parameter Store, data out (first 100 GB free) | under $0.20 |
| **Before tax** | **about $14** |
| **With 18% GST** | **about $16** |

Until 2027-01-31 that is about $55 of the credits. **When the plan ends or the credits run
out, AWS stops the account unless it is upgraded to the Paid plan**: take a backup to your
computer before then.

`ALERT_EMAIL` (one address or several, comma-separated) sets up the same alerts as KeniClean's
account: a monthly budget of $22 counting usage before credits and with tax, with emails at
80%, at 100% and when AWS forecasts the month above it, and a daily email when any service's
spending looks unusual by $2 or more.

## Taking it down

Copy the last backup to your computer first, then:

```bash
AWS_PROFILE=seniq aws cloudformation delete-stack --stack-name seniq --region ap-south-1
```

The bucket and the server's disk are kept on purpose (`Retain`, `DeleteOnTermination: false`);
delete them by hand once you no longer need them, or they keep costing a little.
