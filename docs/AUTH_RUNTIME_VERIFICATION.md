# Authentication Runtime Verification

## Gates

| Check | Command | Needs |
|---|---|---|
| Canonical unit + HTTP contract tests | `npm run test:canonical` (or `npm test`) | no database |
| Auth HTTP contract + OpenAPI parity | `node --test test/auth-http-contract.test.js` | no database |
| Log redaction | `node --test test/auth-logging-redaction.test.js` | no database |
| **PostgreSQL auth concurrency (required for the refresh gate)** | `npm run test:postgres` | local PostgreSQL |
| Schema validity | `npx prisma validate` | — |
| Whitespace hygiene | `git diff --check` | — |

Do not report the rotation invariants as VERIFIED unless `npm run test:postgres` ran successfully against a real PostgreSQL database — mocked-Prisma tests cannot prove claim atomicity.

## How the PostgreSQL suite isolates itself

`test/auth-refresh-postgres.integration.test.js` (gated by `RUN_POSTGRES_INTEGRATION=1`):

1. Loads the project `.env` files once to obtain the base `DATABASE_URL`, then derives an isolated database URL on the same server with database name `gamepedia_auth_contract_it`.
2. Pins `process.env.DATABASE_URL` to that URL and stubs `load-env` in the require cache (both `src/config/env.js` and `prisma.config.js` re-load `.env` files with override enabled and would otherwise silently repoint at the development database).
3. Applies the schema with `npx prisma db push --skip-generate --config <temp config>` — the temp config reads `AUTH_IT_DATABASE_URL`, which no `.env` file defines. This is non-destructive: it creates the database on first run and syncs it afterwards; no reset is used (rows are unique per run).
4. Asserts `current_database()` equals the isolated name before writing anything.

The concurrency tests issue genuinely concurrent transactions over separate pooled connections, i.e. separate PostgreSQL backends. The serialization point is PostgreSQL row locking, so the result is identical whether the connections originate from one Node process or several.

Test sensitivity was validated by temporarily reverting the compare-and-swap claim to an unconditional `update`: the "concurrent refresh" test then fails with two successors, reproducing the original double-issuance bug.

## Coverage map (required matrix)

| # | Invariant | Test |
|---|---|---|
| 1–4 | one concurrent winner / one active successor / replay rejected / successor rotates once | `concurrent refresh of the same token…` |
| 5 | rollback does not consume the original token | `transaction rollback does not consume…` |
| 6–7 | expired (JWT and DB row) / revoked rejected | `expired refresh JWT…`, `database-expired…`, `logout revokes…` |
| 8 | subject mismatch rejected | `refresh token subject must match…` |
| 9–10 | inactive / deleted user cannot refresh | `inactive user cannot refresh`, `account deletion removes…` |
| 11–12 | logout blocks refresh, logout idempotent | `logout revokes the presented session…` |
| 13 | deletion invalidates all sessions | `account deletion removes every refresh session…` |
| 14–15 | reset invalidates all sessions, one concurrent reset winner | `password reset: single-use atomic claim…` |
| 16–17 | one social link under concurrent Apple / Google first login | `concurrent Apple/Google first login…` |
| 18 | credential/raw-body redaction | `auth flows never emit raw credentials…` + `test/auth-logging-redaction.test.js` |
| 19–20 | OpenAPI request/response parity, shared envelope parity | `test/auth-http-contract.test.js` |

## Manual runtime procedure (staging-like)

1. Use an isolated, migrated PostgreSQL database; start the server without production credentials.
2. `GET /health` returns the success envelope.
3. Sign up, then fire two parallel `POST /auth/refresh` with the same token (e.g. `xargs -P2`): expect one `200` and one `401 TOKEN_REVOKED`; replay the old token: `401 TOKEN_REVOKED`.
4. `POST /auth/logout` twice with the same token: both `200 {loggedOut: true}`.
5. `DELETE /auth/me`, then refresh with the last token: `404 ACCOUNT_NOT_FOUND`.
6. Inspect `logs/app.log` for the exercised window: no emails, passwords, or token strings may appear (identifiers are `sha256:` hashed).
7. Never call real Apple/Google endpoints unless explicitly approved; use the stubbed integration tests instead.
