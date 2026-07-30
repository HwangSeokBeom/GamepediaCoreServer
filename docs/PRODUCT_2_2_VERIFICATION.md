# Product 2.2 — Verification

Only confirmed, executed commands are recorded here. Nothing below is aspirational.

Status vocabulary: `VERIFIED`, `IMPLEMENTED_BUT_RUNTIME_UNVERIFIED`, `PARTIAL`,
`BLOCKED_WITH_REASON`.

## Environment used

All Product 2.2 unit and contract tests need these variables. `DATABASE_URL`
deliberately points at a port nothing listens on: the tests stub every Prisma
call they use, so an unstubbed query fails loudly instead of silently reaching a
database.

```
export NODE_ENV=test APP_ENV=test MAIL_MODE=log \
  DATABASE_URL='postgresql://placeholder:placeholder@127.0.0.1:5499/placeholder_unit_only' \
  JWT_ACCESS_SECRET=test-access JWT_REFRESH_SECRET=test-refresh \
  ACCESS_TOKEN_EXPIRES_IN=900 REFRESH_TOKEN_EXPIRES_IN=1209600 BCRYPT_SALT_ROUNDS=4
```

## Confirmed commands

| Level | Command | Result |
|---|---|---|
| Install | `npm ci` | VERIFIED |
| Prisma client | `npx prisma generate` | VERIFIED |
| Syntax | `find src scripts test -name '*.js' ! -name '* 2.js' ! -name '* 3.js' -exec node --check {} \;` | VERIFIED, 0 failures |
| Schema format | `npx prisma format` | VERIFIED |
| Schema validity | `npx prisma validate` | VERIFIED |
| Canonical tests | `npm test` | VERIFIED — 460 tests, 413 pass, 0 fail, 47 skipped |
| PostgreSQL gate | `npm run test:postgres:product-2-2` | VERIFIED — exit 0 |
| Pre-existing auth gate | `npm run test:postgres` | VERIFIED — exit 0, 38 migrations applied, 6/6 tests pass |
| Whitespace | `git diff --check` | VERIFIED, clean |

There is no `test:canonical` script in this repository. `npm test` **is** the
canonical runner (`node scripts/test/run-canonical-tests.js`), which discovers
files ending exactly `.test.js` and excludes the user-owned ` 2.js` / ` 3.js`
duplicates. The 33 skipped tests are the PostgreSQL-gated suites, which run only
with `RUN_POSTGRES_INTEGRATION=1`.

### Focused Product 2.2 suites

Counts are per file, each run on its own with `node --test <file>`:

| File | tests | pass | fail | skipped |
|---|---|---|---|---|
| `catalog-identity.test.js` | 15 | 15 | 0 | 0 |
| `catalog-migration.test.js` | 15 | 15 | 0 | 0 |
| `catalog-submission.test.js` | 21 | 21 | 0 | 0 |
| `playlog.test.js` | 12 | 12 | 0 | 0 |
| `play-intelligence.test.js` | 24 | 24 | 0 | 0 |
| `feed-and-product.test.js` | 35 | 35 | 0 | 0 |
| `http-contract.test.js` | 12 | 12 | 0 | 0 |
| `privacy-and-openapi.test.js` | 11 | 11 | 0 | 0 |
| `product-2-2.postgres.test.js` | 12 | 12 | 0 | 0 (12 skipped without `RUN_POSTGRES_INTEGRATION=1`) |

Product 2.2 adds 157 tests: 145 that run under `npm test` plus the 12
PostgreSQL-gated ones. That matches the suite totals exactly — the baseline was
249 tests / 228 pass / 21 skipped, and it is now 406 / 373 / 33.

## PostgreSQL gate

```
npm run test:postgres:product-2-2
```

`scripts/test/run-product-2-2-postgres-gate.sh` fails closed:

- requires Docker; if Docker is missing or unusable it exits **2** with
  `BLOCKED_WITH_REASON` and never reports a pass,
- generates its own container, credentials and database names, and discards any
  inherited `DATABASE_URL`,
- refuses a database name whose underscore-delimited segments include
  `prod`/`production`/`stage`/`staging`/`live`/`prd`/`stg`,
- confirms the target with `SELECT current_database()` before running anything,
  for both databases it creates,
- binds PostgreSQL to `127.0.0.1` only, and removes the container on exit.

**Phase A — fresh apply.** All 38 repository migrations applied to a new
database; the applied count is compared against the repository count;
`prisma migrate diff --from-url … --to-schema-datamodel prisma/schema.prisma`
must produce an empty migration (schema/migration drift is a hard failure);
`npx prisma generate` runs inside the gate; then the 12 real-database
integration tests in `test/product-2-2/product-2-2.postgres.test.js`.

**Phase B — legacy upgrade.** A second database receives only the 33 pre-Product-2.2
migrations (baseline schema read from the merge base with `origin/main`), is
seeded with `scripts/test/product-2-2-legacy-fixture.sql` — which includes Thai,
Cyrillic, Arabic and trademarked titles — and then has the 5 Product 2.2
migrations applied on top. `scripts/test/verify-product-2-2-backfill.sql`
then asserts, raising on any violation:

1. a `CONFIRMED` mapping collapsed Steam 367520 and IGDB 1942 onto one canonical game
2. a `REJECTED` mapping between two identically titled games did **not** merge
3. a `CANDIDATE` mapping did **not** merge
4. exactly one merge audit row, with decision `CONFIRMED_MAPPING_MERGE`
5. exactly one tombstone
6. zero unbackfilled rows in `user_game_library`, `reviews`, `favorite_games`, `user_activity_events`
7. zero legacy rows pointing at a tombstone
8. legacy identity columns unmodified
9. both merged library rows converged on the same canonical game
10. zero duplicate provider keys, and the unique index exists
11. every surviving canonical game has at least one provider identity
12. no identity claims `PROVIDER_VERIFIED` without a `verifiedAt`
13. no synthetic `PROVIDER:id` placeholder title is still `PUBLISHED`
14. `user_game_library.ownership_provenance` exists, is NOT NULL, and no legacy row
    asserts unprovable provider ownership
15. every non-primary-key unique index on `game_identity_claims` includes
    `catalog_game_id`, and the global provider-key unique index still exists
16. `editorial_articles.current_revision_id` is a real foreign key
17. every article with revisions points at one
18. no alphanumeric title on `catalog_games` or `game_localizations` normalized to
    an empty string

Finally `migrate deploy` is re-run to prove idempotency, and the backfill
assertions are re-checked afterwards.

Last run:

```
Confirmed target database via SELECT current_database(): gamepedia_product_2_2_fresh_…
=== Phase A: fresh apply of all 37 migrations ===
ℹ tests 12  ℹ pass 12  ℹ fail 0
=== Phase B: legacy schema (33 migrations) upgraded with 4 Product 2.2 migrations ===
Confirmed upgrade target database via SELECT current_database(): gamepedia_product_2_2_upgrade_…
NOTICE:  Product 2.2 backfill assertions passed.
NOTICE:  Product 2.2 backfill assertions passed.
Product 2.2 PostgreSQL gate passed.
```

## Required test coverage

| Requirement | Test |
|---|---|
| Legacy client regression | `http-contract.test.js` — 18 legacy routes still registered, `/health` unchanged, no `/api/v1` shadowing |
| Canonical backfill | `verify-product-2-2-backfill.sql` (gate) + `catalog-migration.test.js` |
| Confirmed mappings only merge | `verify-product-2-2-backfill.sql` checks 1–4 + `catalog-migration.test.js` |
| Duplicate false positive | `verify-product-2-2-backfill.sql` checks 2–3 + `catalog-identity.test.js` similarity bounds |
| Malformed AI output / timeout fallback | `catalog-submission.test.js` — 6 malformed bodies, 4 skip reasons, a thrown client error |
| Submission ownership | `catalog-submission.test.js` + `http-contract.test.js` |
| Private/public boundary | `catalog-submission.test.js` (PRIVATE on create, PENDING_REVIEW never PUBLISHED) |
| Playlog idempotency / account isolation | `playlog.test.js` + `product-2-2.postgres.test.js` (5 concurrent retries, cross-account) |
| Game DNA confidence | `play-intelligence.test.js` — thresholds, empty-signal case, determinism |
| Play Compass max 3 / owned only | `play-intelligence.test.js` — 5 candidates → 3, owned-only query filter |
| Replay timezone / DST | `play-intelligence.test.js` — spring forward, fall back, boundary day keys, leap year |
| Article permissions | `feed-and-product.test.js` + `http-contract.test.js` (403 without a DB role) |
| Source allowlist / SSRF | `feed-and-product.test.js` — 10 refusals, 20 blocked addresses, split-horizon DNS, redirect, size, timeout |
| Feed ordering / partial failure | `feed-and-product.test.js` — fixed order, one failing section degrades alone, cursor |
| Raw data log leak | `privacy-and-openapi.test.js` — repository scan plus planted-leak self-test |

## Review-fix coverage

| Review finding | Regression evidence |
|---|---|
| A Today privacy leak (P1) | `review-fixes.test.js` — table-driven over every activity type, six friend privacy combinations, unfiltered settings read, clauses applied in the query, precise empty reasons |
| B new Steam sync rows unusable (P1) | `review-fixes.test.js` linked/partial/unavailable outcomes; gate: concurrent sync converges on one verified identity, and a null row is recovered on the next sync |
| C user input promoted to public/verified (P1) | `catalog-identity.test.js` trust invariant and mandatory trust arguments; `review-fixes.test.js` ownership provenance; gate: a user-supplied provider id creates no game and no identity |
| D quick-add identity squatting (P1) | `catalog-submission.test.js` claim-not-identity; gate: an attacker's claim does not capture a victim's real Steam sync, and Play Compass cannot read a PRIVATE game |
| E concurrent confirm duplication (P1) | gate: ten concurrent confirms → exactly one game, one `personalCatalogGameId`, zero orphans, nine replays, plus a sequential retry |
| F Playlog canonical/release/receipt (P1/P2) | `review-fixes.test.js` tombstone resolution, release clearing, mismatch rejection, receipt rollback, key reuse; gate: six concurrent deletes apply exactly once |
| G international normalization (P1) | `catalog-identity.test.js` 13-script fixture table; gate: byte-level JS/SQL parity over a 19-title corpus and a non-Latin search round trip |
| H magazine body and revision (P1) | `review-fixes.test.js` body carry-forward, publish body, silent-edit refusal, correction audit; gate: full lifecycle with the body intact |
| I feature flag fail-open (P2) | `feed-and-product.test.js` all-false on lookup failure, degraded product-config, environment default only on success; gate: a real flag flip observed without a restart |

## Runtime notes

HTTP runtime is exercised in-process: `http-contract.test.js` binds
`app.listen(0, '127.0.0.1')` and issues real `fetch` requests against every one of
the 26 Product 2.2 operations, so routing, middleware order, kill switches, role
checks, envelopes and status codes are verified over a real socket.

No external provider is contacted by any test. The LLM client is stubbed, and the
editorial source adapters are pure parsers driven by fixtures.

The pre-existing auth gate was re-run because Product 2.2 adds four migrations
and that gate asserts the applied count equals the repository count. It passes
with 37 migrations and 6/6 tests, so the refresh-rotation and push-token
verifications are unaffected.

## Not performed

- No push, PR, merge or deploy.
- No production or staging database was contacted.
- No real IGDB, Steam, Apple, Google or LLM provider call.
- iOS device decoding of the new DTOs is a client task and is outside this
  backend change.
