# GamePedia server redeployment readiness

This document records the replacement-host execution status after the owner
approved abandoning unavailable historical production data and initializing a
new service database. It does not authorize App Store upload or claim that the
public GamePedia application is ready.

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
- Nginx configuration and a certificate for `gamepedia-api.duckdns.org` are
  prepared, but Nginx is stopped to avoid exposing a public 502 response.
- The production PM2 process is not running.
- Exact source commit
  `5a900cac392054ab93e30e13d481c7b00bacfa95` is staged without local changes.
- `npm ci`, Prisma validation/generation, migrations, and JavaScript syntax
  validation pass on the replacement host.

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

## Current blocker and next start sequence

Production startup verifies SMTP during boot. No approved production SMTP
credential exists, so PM2 remains empty and Nginx remains stopped. This is a
hard public-readiness blocker.

1. Store verified SMTP values in `production/gamepedia/runtime` without
   printing or committing them.
2. Run the production environment validator.
3. Start PM2 and prove localhost PostgreSQL, Redis, SMTP, push initialization,
   and `/health`.
4. Enable Nginx only after localhost succeeds.
5. Verify public HTTPS health and the review-account login contract.
6. Complete an actual FCM delivery check if push is in the review scope.

Review credentials are stored only under
`production/gamepedia/review-account`. Database and runtime values are stored
under their corresponding `production/gamepedia/*` secret names.

The current status is `NO-GO_FOR_PUBLIC_APPLICATION`: database initialization,
review-account creation, TLS preparation, and host hardening are complete, but
production SMTP verification and application startup are not.
