# Authentication Runtime Verification

## Executable gates

| Check | Command | Runtime |
|---|---|---|
| Canonical unit and HTTP tests | `npm test` | Node.js; database-dependent tests skip unless explicitly enabled |
| Auth HTTP contract | `node --test test/auth-http-contract.test.js` | Node.js; Prisma calls are stubbed |
| OAuth all-sink redaction | `node --test test/oauth-request-logging.test.js test/auth-logging-redaction.test.js` | Node.js; no live identity provider |
| OpenAPI/runtime contract | `node --test test/api-contract.test.js test/compatibility-contract.test.js test/http-openapi.integration.test.js` | Node.js; service boundaries are stubbed |
| **Disposable PostgreSQL contract gate** | `npm run test:postgres` | Docker and the pinned `postgres:16-alpine` image |
| Schema validity | `DATABASE_URL=<disposable-url> npx prisma validate` | No database connection |
| Whitespace hygiene | `git diff --check` | Git |

Do not report database concurrency behavior as verified unless
`npm run test:postgres` exits successfully.

## How the PostgreSQL gate isolates itself

`scripts/test/run-auth-postgres-gate.sh` is the only documented PostgreSQL
contract runner. It:

1. Requires a working Docker daemon and fails closed when Docker is unavailable.
2. Creates a uniquely named PostgreSQL 16 container and database for each run.
3. Publishes PostgreSQL only on a Docker-selected `127.0.0.1` port.
4. Ignores any inherited `DATABASE_URL` and supplies the generated URL only to
   child Prisma and test commands.
5. Waits at most 60 seconds for readiness.
6. verifies `current_database()` before running any migration or test.
7. runs `prisma migrate deploy` and verifies that every repository migration was
   applied successfully.
8. runs only the PostgreSQL test files listed below.
9. removes the exact disposable container through a trap on success, failure,
   or interruption.

The runner never accepts a user-provided database and must not be adapted to
point at development, staging, or production.

## PostgreSQL coverage

The isolated runner executes:

- `test/auth-refresh-postgres.integration.test.js`
  - exactly one winner for concurrent refresh-token rotation
  - replay rejection and one active successor
  - source-level presence of the compare-and-swap predicate
- `test/auth-signup-postgres.integration.test.js`
  - two HTTP signups released through the same deterministic precheck gate
  - one `201` response and one `409 EMAIL_ALREADY_IN_USE`
  - one persisted user for the normalized email
- `test/push-token-postgres.integration.test.js`
  - cleanup behavior
  - one owner under concurrent push-token registration
  - 4096-character token storage and reassignment through the fixed-size hash

This gate does not claim to verify password-reset concurrency, social-login
concurrency, account deletion, external Apple/Google behavior, SMTP delivery,
or every server PostgreSQL integration test.

## External and skipped behavior

- Apple and Google provider calls remain stubbed; live identity-provider
  verification requires separately authorized credentials and network access.
- Canonical `npm test` discovery includes PostgreSQL-gated files, but their
  database cases are skipped unless `RUN_POSTGRES_INTEGRATION=1`.
- SMTP, Firebase, AWS, DNS, deployment, and production databases are outside
  this gate.
