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
| Install | `npm ci` / `npm ci --omit=dev --omit=optional` | VERIFIED — local Node.js 26 validation install plus isolated Node.js 22.23.1 validation/runtime installs; 235 validation packages or 209 runtime packages installed, 0 vulnerabilities |
| Prisma client | `npx prisma generate` | VERIFIED |
| Syntax | `find src scripts test -name '*.js' ! -name '* 2.js' ! -name '* 3.js' -exec node --check {} \;` | VERIFIED, 0 failures |
| Schema format | `npx prisma format` | VERIFIED |
| Schema validity | `npx prisma validate` | VERIFIED |
| OpenAPI JSON | `node -e "JSON.parse(require('node:fs').readFileSync('openapi/product-2.2.openapi.json', 'utf8'))"` | VERIFIED |
| OpenAPI 3.1 | `npm run test:openapi-contract` | VERIFIED — pinned Redocly 2.41.2 recommended lint, 0 errors/warnings, 1 exact ignored deprecated-alias finding |
| iOS generated client | `npm run test:ios-openapi-contract` | VERIFIED — Apple generator 1.11.1/runtime 1.12.0, all eight successful Today sections plus the null failure branch, typed catalog confirm/status results, and catalog/Playlog pagination cursors decoded with generated types; generic iOS Simulator SDK compile |
| Deployed dependency audit | `npm run test:dependency-security` | VERIFIED — package/workflow/deploy contract check, omitted dev/Firestore/Storage packages confirmed absent, 0 vulnerabilities at moderate severity or higher |
| Canonical tests | `npm test` | VERIFIED — 53 files, 515 tests, 448 pass, 0 fail, 67 skipped |
| PostgreSQL gate | `npm run test:postgres:product-2-2` | VERIFIED — exit 0, 40 fresh migrations, 33 legacy + 7 Product 2.2 upgrade migrations, 55/55 real-database tests |
| Seed-twice PostgreSQL gate | `npm run test:postgres:product-2-2:seed` | VERIFIED — exit 0, 40 migrations, two consecutive documented seed runs, stable 3-game/4-claim/0-identity/1-linked-revision snapshot |
| Pre-existing auth gate | `npm run test:postgres` | VERIFIED — exit 0, 40 migrations applied, 6/6 tests pass |
| Whitespace | `git diff --check` | VERIFIED, clean |

There is no `test:canonical` script in this repository. `npm test` **is** the
canonical runner (`node scripts/test/run-canonical-tests.js`), which discovers
files ending exactly `.test.js` and excludes the user-owned ` 2.js` / ` 3.js`
duplicates. All 67 skips are explicit database-isolation guards, not weakened
assertions:

- 46 Product 2.2 top-level skips require `RUN_POSTGRES_INTEGRATION=1`; the
  Product gate executes 54 TAP-counted cases on the fresh database (the two
  round-3 parents expand to 11 subtests) and one victim-sync case after a real
  legacy upgrade;
- 4 top-level auth/signup/push skips run inside `npm run test:postgres`, whose
  files produce 6/6 TAP-counted cases including their always-on source/cleanup
  guards;
- 17 pre-existing account-deletion (6), refresh-rotation (1),
  library-atomicity (4), friend-pagination (5), and password-reset (1) cases
  require a separately named dedicated audit database. The placeholder unit URL
  intentionally cannot satisfy that guard, so `npm test` never contacts an
  accidental database.

### Focused Product 2.2 suites

Counts are per file, each run on its own with `node --test <file>`:

| File | tests | pass | fail | skipped |
|---|---|---|---|---|
| `catalog-identity.test.js` | 29 | 29 | 0 | 0 |
| `catalog-migration.test.js` | 17 | 17 | 0 | 0 |
| `catalog-submission.test.js` | 22 | 22 | 0 | 0 |
| `playlog.test.js` | 12 | 12 | 0 | 0 |
| `play-intelligence.test.js` | 24 | 24 | 0 | 0 |
| `feed-and-product.test.js` | 41 | 41 | 0 | 0 |
| `http-contract.test.js` | 13 | 13 | 0 | 0 |
| `privacy-and-openapi.test.js` | 19 | 19 | 0 | 0 |
| `review-fixes.test.js` | 30 | 30 | 0 | 0 |
| `round-2-unit.test.js` | 12 | 12 | 0 | 0 |
| `product-2-2.postgres.test.js` | 28 | 28 | 0 | 0 in the gate (28 skipped without `RUN_POSTGRES_INTEGRATION=1`) |
| `round-2-attacks.postgres.test.js` | 10 | 10 | 0 | 0 in the gate (10 skipped without `RUN_POSTGRES_INTEGRATION=1`) |
| `round-3-regressions.postgres.test.js` | 11 | 11 | 0 | 0 in the gate (2 parent tests skipped without `RUN_POSTGRES_INTEGRATION=1`) |
| `ios-contract.postgres.test.js` | 5 | 5 | 0 | 0 in the gate (5 skipped without `RUN_POSTGRES_INTEGRATION=1`) |
| `legacy-upgrade.postgres.test.js` | 1 | 1 | 0 | 0 in the upgraded-database gate (1 skipped without `RUN_POSTGRES_INTEGRATION=1`) |

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

**Phase A — fresh apply.** All 40 repository migrations applied to a new
database; the applied count is compared against the repository count (`find
prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l` is 40, and the gate
reads it rather than hard-coding it);
`prisma migrate diff --from-url … --to-schema-datamodel prisma/schema.prisma`
must produce an empty migration (schema/migration drift is a hard failure);
`npx prisma generate` and normalization reconciliation run inside the gate; then the 28 real-database
integration tests in `test/product-2-2/product-2-2.postgres.test.js`, the 10
round-2 attack tests in `test/product-2-2/round-2-attacks.postgres.test.js`, and
the 11 TAP-counted tests in `test/product-2-2/round-3-regressions.postgres.test.js`.

**Phase B — legacy upgrade.** A second database receives only the 33 pre-Product-2.2
migrations (baseline schema read from the merge base with `origin/main`), is
seeded with `scripts/test/product-2-2-legacy-fixture.sql` — which includes Thai,
Cyrillic, Arabic and trademarked titles — and then has the 7 Product 2.2
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
11. every surviving canonical game is still reachable by a provider key — a verified
    identity or, for a legacy row, a claim
12. `game_external_identities` contains **only** verified rows (a verified provenance,
    a non-null `verified_at` and a non-blank `verification_source`); every legacy row
    arrived in `game_identity_claims` with `claim_source = 'legacy_backfill_unverified'`
    rather than being deleted; and no claim asserts verified provenance
13. no synthetic `PROVIDER:id` placeholder title is still `PUBLISHED`
14. `user_game_library.ownership_provenance` exists, is NOT NULL, and no legacy row
    asserts unprovable provider ownership
15. every non-primary-key unique index on `game_identity_claims` includes
    `catalog_game_id`, and the global provider-key unique index still exists
16. `editorial_articles.current_revision_id` is a real foreign key
17. every article with revisions points at one
18. no alphanumeric title on `catalog_games` or `game_localizations` normalized to
    an empty string
19. no `PUBLISHED` catalog game carries unverified title provenance — the rule is the
    provenance, not the shape of the string, so a realistic-looking legacy title is
    demoted like a placeholder
20. no `game_localizations` row claims a verified provenance its game never earned
21. all four round-2 CHECK constraints exist, and `verified_at` and
    `verification_source` are both NOT NULL

Finally `migrate deploy` is re-run to prove idempotency, and the backfill
assertions are re-checked afterwards. The upgraded database then runs
`legacy-upgrade.postgres.test.js`, which starts from the pre-2.2 malicious
identity fixture and invokes the real trusted Steam ownership sync after the
actual migrations.

Last run:

```
Confirmed target database via SELECT current_database(): gamepedia_product_2_2_fresh_…
=== Phase A: fresh apply of all 40 migrations ===
Confirming the schema and the migrations agree (an empty diff is required).
Running the Product 2.2 real-database integration tests.
ℹ tests 28  ℹ pass 28  ℹ fail 0  ℹ skipped 0
Running the round-2 attack tests (identity capture, atomicity, editorial races, Unicode parity).
ℹ tests 10  ℹ pass 10  ℹ fail 0  ℹ skipped 0
Running the round-3 regression tests (correction deltas and Unicode storage boundaries).
ℹ tests 11  ℹ pass 11  ℹ fail 0  ℹ skipped 0
=== Phase B: legacy schema (33 migrations) upgraded with 7 Product 2.2 migrations ===
Confirmed upgrade target database via SELECT current_database(): gamepedia_product_2_2_upgrade_…
NOTICE:  Product 2.2 backfill, review-fix and round-2 assertions passed.
ℹ tests 1  ℹ pass 1  ℹ fail 0  ℹ skipped 0
Re-running the migrations to confirm they are idempotent (no pending work).
NOTICE:  Product 2.2 backfill, review-fix and round-2 assertions passed.
Product 2.2 PostgreSQL gate passed.
  fresh database:   gamepedia_product_2_2_fresh_… (40 migrations)
  upgraded database: gamepedia_product_2_2_upgrade_… (33 legacy + 7 Product 2.2)
```

## Seed-twice PostgreSQL gate

```
npm run test:postgres:product-2-2:seed
```

The gate creates a separate disposable PostgreSQL 16 database, probes its exact
name, runs `npx prisma generate`, applies and reconciles all 40 migrations, and executes the
documented `npm run seed:product-2-2:dev` command twice. The verifier requires
both snapshots to match: 3 catalog games, 4 unverified identity claims, zero
verified external identities, and one editorial revision whose id is exactly
the article's `currentRevisionId`. Development provider ids are claims, not
fabricated verification; published fixture titles explicitly use
`EDITOR_VERIFIED` provenance.

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
| Canonical correction delta | `round-3-regressions.postgres.test.js` — equal scalars, trim-equivalent body, relation reordering/duplicate upserts, and a real delta inside the locked transaction |
| Today generated-client contract | `privacy-and-openapi.test.js` — graph traversal from the Today 200 response reaches all eight key-specific data schemas and `ArticleSummary`; every data schema requires exactly its runtime fields; `feed-and-product.test.js` checks the eight actual runtime field sets |
| iOS generated client | `npm run test:ios-openapi-contract` — pinned Apple Swift OpenAPI Generator 1.11.1 / runtime 1.12.0, all eight successful Today sections and the required-null failure branch, typed catalog confirm/status results, and catalog/Playlog pagination cursors decoded with generated types, plus a generic iOS Simulator SDK compile |
| Unpaired-surrogate refusal | `catalog-identity.test.js`, `catalog-submission.test.js`, `http-contract.test.js`, and `round-3-regressions.postgres.test.js` — high/low/mixed lone surrogates fail before storage; valid astral Unicode round-trips |
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
| G international normalization (P1) | `catalog-identity.test.js` 13-script fixture table; gate: pinned application reconciliation over a 19-title corpus and a non-Latin search round trip |
| H magazine body and revision (P1) | `review-fixes.test.js` body carry-forward, publish body, silent-edit refusal, correction audit; gate: full lifecycle with the body intact |
| I feature flag fail-open (P2) | `feed-and-product.test.js` all-false on lookup failure, degraded product-config, environment default only on success; gate: a real flag flip observed without a restart |

## Runtime notes

HTTP runtime is exercised in-process: `http-contract.test.js` binds
`app.listen(0, '127.0.0.1')` and issues real `fetch` requests against every one of
the 26 Product 2.2 operations, so routing, middleware order, kill switches, role
checks, envelopes and status codes are verified over a real socket.

No external provider is contacted by any test. The LLM client is stubbed, and the
editorial source adapters are pure parsers driven by fixtures.

The pre-existing auth gate was re-run because Product 2.2 adds migrations and that
gate asserts the applied count equals the repository count. It passes with 40
migrations and 6/6 tests, so the refresh-rotation and push-token verifications are
unaffected.

## Round-2 review-fix coverage

Each finding is proved on a real PostgreSQL 16 database, because every one of them
was about something only a database has: a CHECK constraint, a row lock, a
transaction rollback, or a genuine race between connections.

| Round-2 finding | Evidence |
|---|---|
| A legacy Steam identity capture (P1) | `round-2-attacks.postgres.test.js` — the attack is performed: an attacker's claim on an appid, then the victim's real sync. The sync returns a different canonical game, keeps `Real Provider Title`/`PUBLISHED`/`PROVIDER_VERIFIED`, and the attacker's game stays `PENDING_REVIEW`/`USER_CONFIRMED` and unmerged. Plus: the database refuses all five unverified global-identity shapes with SQLSTATE 23514/23502, the migration demoted realistic legacy titles and their localizations, and all four CHECK constraints exist. Unit: `catalog-identity.test.js` — no promotion path remains |
| B catalog creation atomicity (P2) | `round-2-attacks.postgres.test.js` — a disposable PostgreSQL trigger fails the identity insert during the real `ensureVerifiedCanonicalGameForIdentity` call, proving the service transaction rolls back game, localization, and identity together; retry and replay remain idempotent. Ten concurrent syncs of one appid converge on one canonical game and one identity with no leftovers. Unit: `review-fixes.test.js` — a rolled-back entry leaves no linked library row |
| C editorial TOCTOU (P1) | `round-2-attacks.postgres.test.js` — a real edit-versus-publish race asserts the exact allowed outcomes and cannot pass if both operations fail. The hero race uses two connections, an article row lock, and a `pg_blocking_pids` barrier so the asset commits while publish is blocked, with no arbitrary sleep. Unit: `feed-and-product.test.js` and `review-fixes.test.js` — the lock is taken before anything is read, a stale `expectedRevisionNumber` is a 409, and a role revoked mid-request is refused |
| D magazine publication contract (P1/P2) | `round-2-attacks.postgres.test.js` — a null body cannot be published, a status-only `CORRECTED` is refused, a noteless correction is refused, a proper correction succeeds, and a SQL sweep confirms no publicly readable article in the database has an empty body or a noteless correction. Unit: `review-fixes.test.js` DTO split; `privacy-and-openapi.test.js` — the contract's non-null promises match what the server enforces |
| E Markdown rights/privacy bypass (P1) | `round-2-attacks.postgres.test.js` — four image forms refused at the write boundary, and a body written directly to the table is still refused at publish, with the rejection carrying reason codes and not the tracking URL. Unit: `round-2-unit.test.js` — twelve image syntaxes, seven raw-HTML positions, eleven refused link destinations, one accepted ordinary body, and a planted-leak check over the error and the logs |
| F Unicode storage semantics (P2) | `round-2-attacks.postgres.test.js` — a seven-title corpus stored in `varchar(300)`, asserting `char_length` equals the JavaScript code-point count and `left(value, 300)` equals `clampTitle(value)`. Unit: `round-2-unit.test.js` — the exact defect (`'a' + '\u{20BB7}'.repeat(200)`), boundary-straddling surrogate pairs, nine-script corpus, slug budget |

### Frozen Unicode normalization contract

Storage length and malformed-UTF-16 behavior remain proved over the named corpus:
ASCII, Hangul, Thai, Arabic, Cyrillic, Latin with combining marks, astral CJK
(U+20BB7), emoji (U+1F600), and mixtures of these. `char_length` equals
`countCodePoints`, `left(value, 300)` equals `clampTitle(value)` for
untrimmed-equal inputs, valid astral values round-trip, and lone surrogates never
reach PostgreSQL.

Canonical title normalization is no longer a corpus-only JS/PostgreSQL parity
claim. NFKC comes from pinned `unorm` 1.6.0 Unicode 8.0 data; lowercase and
letter/number classification come from pinned `@unicode/unicode-8.0.0` 1.6.17
data. Native Node.js/ICU and PostgreSQL Unicode tables do not participate. The
deploy-time reconciler atomically rewrites historical rows, rejects localization
collisions, and records
`unicode-8.0-unorm-1.6.0-data-1.6.17-v1`; server startup verifies the marker and
all stored canonical titles before listening. A post-Unicode-8 compatibility
character proves newer host tables cannot change the result.

This deliberately freezes behavior rather than claiming support for future
Unicode assignments. A character introduced after Unicode 8 remains a separator
until an explicit contract-version migration and full reconciliation upgrades
the data.

## Not performed

- No push, PR, merge or deploy.
- No production or staging database was contacted.
- No real IGDB, Steam, Apple, Google or LLM provider call.
- No physical iOS device or shipping app target was built. The server contract
  was generated and decoded with Apple's generated Swift types and compiled for
  the generic iOS Simulator SDK.
