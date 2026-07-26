# GamePedia server redeployment readiness

This document records the replacement-host execution status after the owner
approved abandoning unavailable historical production data and initializing a
new service database. It does not authorize App Store upload.

## Operations guide

Day-to-day access, health checks, log inspection, safe restarts, incident
response, and deployment handoff are documented in
[OPERATIONS_RUNBOOK.md](./OPERATIONS_RUNBOOK.md).

## Canonical runtime contract

- region: `ap-northeast-2`
- public host: `gamepedia-api.duckdns.org`
- application port: `3001`
- PM2 application: `core-server`
- source path: `/home/ec2-user/GamePediaCoreServer-prod`
- entry point: `node src/server.js`
- liveness endpoint: `/health`
- database: PostgreSQL through `DATABASE_URL`
- cache: Redis through `REDIS_URL`

The current source does not expose a dedicated application WebSocket server.
Do not add WebSocket proxying solely because a transitive dependency contains
WebSocket code.

## Replacement-host state

- The replacement instance is managed through SSM Session Manager.
- The instance has an Elastic IP and DuckDNS resolves the canonical hostname
  to it.
- Only ports 80 and 443 are public. SSH, Node.js, PostgreSQL, and Redis ports
  are not public.
- Node.js 22, npm, PM2 7.0.3, Nginx, PostgreSQL 16, Redis 6, and Certbot are
  installed.
- Redis is enabled on loopback.
- Nginx is active and enabled with a valid certificate for
  `gamepedia-api.duckdns.org`.
- PM2 application `core-server` is online and `pm2-ec2-user` is active and
  enabled for reboot recovery.
- Exact source commit
  `5a900cac392054ab93e30e13d481c7b00bacfa95` is staged without local changes.
- `npm ci`, Prisma validation/generation, migrations, and JavaScript syntax
  validation pass on the replacement host.
- CloudWatch Agent collects PM2 and Nginx logs plus memory/root-disk metrics.
- EC2 status/CPU and shared RDS CPU/storage/connection alarms exist. All 15
  shared alarms send `ALARM` and `OK` actions to the SNS topic
  `project-services-ops-alerts`.
- The SNS topic has one email subscription in `PendingConfirmation`; no human
  alert is delivered until the owner confirms the AWS notification email.
- Production startup verifies the configured Gmail SMTP transport.
- Firebase Admin initializes from Secrets Manager-backed base64 credentials
  for project `gamepedia-eb58c`.
- Public HTTPS review-account login, current-user lookup, temporary push-token
  registration, and immediate deletion all return 200.

## Environment-name contract

Use `.env.production.example` as the source of required variable names.
Secret values must be injected from an approved secret store or a root-owned
file outside the repository. In particular, never commit or print:

- database or Redis connection values
- JWT secrets
- mail credentials
- Apple, Google, Twitch, Steam, LLM, or Firebase credentials

Production must resolve to:

- `NODE_ENV=production`
- `APP_ENV=production`
- `HOST=127.0.0.1`
- `PORT=3001`
- `APP_WEB_BASE_URL=https://gamepedia-api.duckdns.org`
- `API_PUBLIC_BASE_URL=https://gamepedia-api.duckdns.org`

Run `npm run deploy:validate:production` after the real secret values are
injected and before PM2 is allowed to start.

## Health limitation

`/health` reports process, mail, and push initialization state. It is not a
complete PostgreSQL/Redis readiness probe. Until a dedicated readiness check
exists, the cutover gate must separately prove:

1. a PostgreSQL query succeeds against the restored database;
2. Redis `PING` succeeds against the service-specific Redis instance;
3. SMTP startup verification succeeds;
4. Firebase initialization matches the intended production project;
5. `/health` returns 200 through localhost and then through Nginx.

## Data state

- Historical production data is classified `NO_BACKUP_FOUND`.
- The owner explicitly approved abandoning historical recovery.
- A new `gamepedia` database and least-privilege `gamepedia_app` role were
  created on the private shared RDS instance.
- All 33 Prisma migrations were applied.
- One review account was created and login-tested through a temporary
  localhost-only development process.
- The initialized RDS state is protected by encrypted snapshot
  `project-services-postgres-initialized-20260726`, which is available.
- The new initialized state is classified `RECOVERABLE`.

## Current blockers and next sequence

1. Confirm the SNS email subscription.
2. Complete an actual APNs/FCM delivery check with a TestFlight device token.
   The server-side registration/deletion contract and Firebase initialization
   are verified, but a synthetic token is not delivery proof.
3. Keep the Free Plan RDS limitation documented: `db.t4g.micro`, single-AZ,
   one-day backup retention. Reassess class, retention, deletion protection,
   and Multi-AZ before a production-scale cutover.
4. Run the signed iOS archive and TestFlight review-account regression under a
   separately approved client release step.

Review credentials are stored only under
`production/gamepedia/review-account`. Database and runtime values are stored
under their corresponding `production/gamepedia/*` secret names.

The current status is `PUBLIC_RUNTIME_READY_WITH_RELEASE_BLOCKERS`: database,
SMTP, Firebase initialization, review-account login, PM2 reboot recovery,
Nginx, TLS, and public health are verified. Actual device push delivery, SNS
confirmation, and signed client release verification remain.
