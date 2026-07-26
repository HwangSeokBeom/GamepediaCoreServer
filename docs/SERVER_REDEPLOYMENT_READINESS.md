# GamePedia server redeployment readiness

This document records the safe stopping point immediately before restoring
production data and starting the replacement server. It does not authorize a
database migration, process restart, DNS change, certificate issuance, or
production cutover.

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
- Nginx, PostgreSQL, Redis, and the application process remain stopped.
- Exact source commit
  `a91feb238939a8d16e01774f9879ca68a147069e` is staged without local changes.
- `npm ci`, Prisma validation/generation, and JavaScript syntax validation
  pass on the replacement host.

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

## Data-recovery gate

The new AWS account currently contains no RDS snapshot, EBS snapshot, AMI, S3
backup, or AWS Backup recovery point for the previous deployment. The old
account or an independently stored backup must provide:

1. a timestamped PostgreSQL logical dump;
2. an EBS/RDS snapshot where applicable;
3. encryption and size evidence;
4. a successful restore into an isolated database;
5. all Prisma migrations applied with `prisma migrate deploy`;
6. core table row counts and relationship checks.

Do not initialize an empty production database or start PM2 while this gate is
unresolved.

## Pre-start sequence

1. Obtain and verify the old-account backup without exposing credentials.
2. Restore it into an isolated rehearsal database.
3. Run the canonical and PostgreSQL test suites against the rehearsal copy.
4. Create service-specific production PostgreSQL and Redis storage.
5. Inject production environment values outside Git.
6. Run `npm run deploy:validate:production`.
7. Install the reviewed Nginx template but do not reload yet.
8. Start PM2 only during the approved cutover window.
9. Verify localhost database, Redis, SMTP, push, and `/health`.
10. Issue/attach TLS, reload Nginx, and verify the public endpoint.

The current approved stopping point is immediately before step 1.
