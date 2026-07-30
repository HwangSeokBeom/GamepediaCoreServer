# Product 2.2 — Play Intelligence Server

> **Naming.** "Product 2.2" is this product slice. It is deliberately *not* the
> "2.2" of any earlier technical roadmap, and the two must not be conflated.

## Goal

Let a player decide what to play right now from the games they already own,
record and analyse what they actually played, and register a game that exists in
neither IGDB nor Steam.

## Scope

Additive only. Every pre-existing route (`/games/*`, `/reviews`,
`/users/me/library`, the Steam surface, the AI endpoints, `/health`) keeps its
current path, behavior and response shape. Product 2.2 lives entirely under
`/api/v1`, is mounted last, and shadows nothing.

Machine-readable contract: [`openapi/product-2.2.openapi.json`](../openapi/product-2.2.openapi.json).
The deployed mobile gate subset stays in
[`openapi/cross-platform.openapi.json`](../openapi/cross-platform.openapi.json)
and is unchanged.

## API surface

| Method | Path | Kill switch |
|---|---|---|
| GET | `/api/v1/catalog/games/search` | `openCatalog` |
| GET | `/api/v1/catalog/games/{catalogGameId}` | `openCatalog` |
| POST | `/api/v1/catalog/submissions/preview` | `aiQuickAdd` |
| POST | `/api/v1/catalog/submissions/{submissionId}/confirm` | `aiQuickAdd` |
| GET | `/api/v1/catalog/submissions/{submissionId}` | `aiQuickAdd` |
| POST | `/api/v1/catalog/games/{catalogGameId}/corrections` | `openCatalog` |
| PUT | `/api/v1/catalog/games/{catalogGameId}/follow` | `openCatalog` |
| DELETE | `/api/v1/catalog/games/{catalogGameId}/follow` | `openCatalog` |
| GET | `/api/v1/users/me/play-sessions` | `playlog` |
| POST | `/api/v1/users/me/play-sessions` | `playlog` |
| PATCH | `/api/v1/users/me/play-sessions/{id}` | `playlog` |
| DELETE | `/api/v1/users/me/play-sessions/{id}` | `playlog` |
| GET | `/api/v1/users/me/play-sessions/calendar` | `playlog` |
| GET | `/api/v1/users/me/game-dna` | `gameDNA` |
| POST | `/api/v1/users/me/play-compass` | `playCompass` |
| POST | `/api/v1/users/me/play-compass/events` | `playCompass` |
| GET | `/api/v1/users/me/replays/monthly` | `monthlyReplay` |
| GET | `/api/v1/users/me/today` | `todayFeed` |
| GET | `/api/v1/articles/{slug}` | `magazine` |
| GET | `/api/v1/editorial/articles` | `magazine` + EDITOR/ADMIN |
| POST | `/api/v1/editorial/articles` | `magazine` + EDITOR/ADMIN |
| PATCH | `/api/v1/editorial/articles/{slug}` | `magazine` + EDITOR/ADMIN |
| POST | `/api/v1/editorial/articles/{slug}/publish` | `magazine` + EDITOR/ADMIN |
| POST | `/api/v1/editorial/articles/{slug}/retract` | `magazine` + EDITOR/ADMIN |
| GET | `/api/v1/product-config` | none (by design) |
| POST | `/api/v1/product-events` | none (by design) |

`product-config` and `product-events` are intentionally ungated: a client needs
the config to learn which features are off, and event intake must keep working
while a feature is disabled. A disabled feature returns `503 FEATURE_DISABLED`.

## Canonical game catalog

`CatalogGame` is the game *work*, identified by a UUID. Everything that varies by
market lives beside it:

- `RegionalRelease` — one country/language/platform service edition with its own
  operator, server region, release and shutdown dates, and a lifecycle status
  (`ANNOUNCED | PRE_REGISTRATION | LIVE | MAINTENANCE | SUNSET_ANNOUNCED |
  SHUTDOWN`).
- `GameLocalization` — the original title, per-region titles and aliases as
  separate rows, so a regional title can never overwrite the original.
- `GameExternalIdentity` — a provider key, unique in the database on
  `(provider, externalId, regionKey)`. Providers: `IGDB | STEAM |
  APPLE_APP_STORE | GOOGLE_PLAY | OFFICIAL_SITE | COMMUNITY`.
- `GameAsset`, `GameFieldEvidence`, `GameSubmission`, `CatalogMergeAudit`,
  `GameFollow`.

Provenance is a first-class enum on facts, identities, localizations, releases,
assets and evidence: `PROVIDER_VERIFIED | OFFICIAL_SOURCE | USER_CONFIRMED |
COMMUNITY_CONFIRMED | EDITOR_VERIFIED | AI_INFERRED | UNKNOWN | DISPUTED`.

### Sentinels instead of NULL inside unique keys

`GameExternalIdentity.regionKey` and `GameLocalization.regionCode` are `NOT NULL`
with a `'GLOBAL'` default. PostgreSQL treats every `NULL` as distinct, so a
nullable column inside a `UNIQUE` constraint silently permits unlimited
duplicates. A test enforces that no compound unique key added by Product 2.2
contains a nullable column.

### Legacy data migration

`catalog_game_id` was added as a **nullable** column to `reviews`,
`favorite_games`, `user_game_library` and `user_activity_events`. The legacy
identity columns (`game_id`, `game_source` / `external_game_id`,
`igdb_game_id`) remain authoritative and are neither dropped nor retyped.

The backfill in
`prisma/migrations/20260730120000_create_catalog_game_identity/migration.sql`:

1. collects every distinct legacy IGDB/Steam identity from all four tables
   (`reviews.game_id` and `favorite_games.game_id` are IGDB identities, because
   the library module resolves them through `igdbService.getGamesByIds`),
2. creates one canonical game and one identity row per distinct provider key,
3. merges **only** `SteamIgdbMapping` rows with `match_status = 'CONFIRMED'`,
   repointing the Steam identity onto the IGDB canonical game,
4. leaves the collapsed game as a tombstone (`merged_into_catalog_game_id`) plus
   a `CatalogMergeAudit` row, so a historical id stays resolvable,
5. attaches `catalog_game_id` to every legacy row **through the already
   repointed identity**, so no legacy row ever points at a tombstone.

`CANDIDATE`, `UNMATCHED` and `REJECTED` mappings are never merged automatically.
Two identically titled games from different providers with no confirmed mapping
stay separate — the duplicate-false-positive case is covered by a gate assertion.

New writes dual-write: the legacy identity is written first and stays
authoritative, then `catalogGameId` is filled in. The dual-write hooks are
best effort by design — a catalog failure logs a category and returns, so game
search, Steam sync, reviews and the library cannot break because of the catalog.

Existing response shapes are untouched. `catalogGameId` and `identities` appear
only in the new Product 2.2 DTOs.

## AI quick add

Resolution order, deterministic first:

1. URL / Apple app id / Google Play package id parsing
2. provider identity exact match
3. locale alias and normalized title exact match
4. fuzzy title with developer, platform and region signals
5. LLM structured extraction — only when the above cannot answer
6. Zod validation
7. write on explicit user confirmation

Invariants:

- **AI output is not a source.** Every extracted field is pinned to
  `AI_INFERRED` at the extractor boundary, whatever the completion claims.
- **AI never publishes and never merges.** Personal registration is immediate and
  `PRIVATE`; public visibility only ever reaches `PENDING_REVIEW`. A submitter's
  own confirmation never sets `reviewedByUserId` / `reviewedAt`.
- **Raw natural language is never persisted.** Only a SHA-256 fingerprint and
  structured fields are stored. When no structured title can be derived the draft
  keeps `originalTitle: null` with `requiresTitleConfirmation: true`, and
  confirming without a title is rejected (`SUBMISSION_TITLE_REQUIRED`).
- **The server never fetches a user-supplied URL.** Only its structure is parsed,
  so a submitted link cannot make the server reach an internal address.
- **Provider page content is untrusted data.** The prompt fences it and instructs
  the model never to follow instructions found inside it.
- **Every AI failure degrades.** Timeout, quota, unsupported provider, unparsable
  body and schema rejection all fall back to a minimal manual draft.
- **The AI budget is shared.** Quick add increments and checks
  `ai_usage_limits.quick_add_count` inside one transaction, reusing the existing
  per-user daily limiter.
- A provider key already owned by another canonical game is reported as an
  identity conflict for review, never silently repointed.

## Playlog, Game DNA, Play Compass, Monthly Replay

**Playlog.** `(userId, clientMutationId)` is unique on `play_sessions`, so a
retried create returns the original record instead of a duplicate. Update and
delete record the same key in `client_mutation_receipts`. Ownership is part of
every lookup, so another account's session resolves to `404`, never `403`.
Pagination is keyset on `(playedAt desc, id desc)` — a unique total order.
`visibility` defaults to `PRIVATE`.

**Game DNA** is deterministic. Inputs: ratings, library status, completion and
drop outcomes, playtime, genres, Steam tags, recent play and Playlog outcome
states. The Playlog query does not select `note`, so note bodies are never read.
It reports `signalCount`, confidence, `generatedAt` with freshness, the five
axes, the signals it is missing, and structured reason codes. It works unchanged
with AI disabled; narration would be additive and optional.

**Play Compass** is a deterministic ranker with no model. Candidates are only
owned `PLAYING`/`BACKLOG` library entries, so a default request never proposes an
unowned game. At most three picks, each with score components, allowlisted reason
codes, confidence, freshness and ownership evidence with its provenance. Install
state is reported as unknown rather than guessed, because this backend does not
track it. Feedback accepts only `SELECTED | EXCLUDED | SNOOZED | PLAY_CONFIRMED`.

**Monthly Replay** resolves month boundaries and day buckets by inverting the
zone offset at the candidate instant, so DST is handled: a spring-forward local
month is one hour shorter than 31×24h and a fall-back month one hour longer, and
a session at 23:59 local on a transition day stays on that local day. It reports
an explicit empty-month state and structured notes for anything it could not
account for.

## Today feed and magazine

Sections are settled independently with `Promise.allSettled`. A section that
throws is reported as `unavailable` with a reason code while every other section
still renders; a section whose kill switch is off is `disabled`, which is not a
partial failure. Section order is fixed, in-section sorts are deterministic, and
the cursor is an opaque base64url index.

Editorial workflow: `DRAFT → FACT_CHECK → RIGHTS_REVIEW → SCHEDULED → PUBLISHED`,
then `CORRECTED` or `RETRACTED`. Any other transition is `409`. An AI-assisted
draft may only ever be `DRAFT`. Publish and retract re-read EDITOR/ADMIN from
`user_role_assignments`, so a revoked role stops working immediately rather than
when the access token expires. An article whose hero image has an unresolved
rights status cannot be published, and the DTO withholds such an image with a
reason instead of serving it.

Content policy: `ArticleSource` stores a headline, a clamped excerpt (≤400
characters), the source URL, `publishedAt`, `fetchedAt` and a content hash —
never a full third-party article. The RSS adapter deliberately ignores
`content:encoded`.

Source adapters are pure parsers over an already-fetched document, exercised
entirely from fixtures. **No real provider is contacted anywhere in this
repository.** Fetching goes through `src/modules/feed/safe-fetch.js`:
administrator-configured host allowlist, HTTPS only, bounded timeout, bounded
response size, `redirect: 'manual'` with any 30x refused, literal-IP hosts
refused, and a DNS check that rejects private, loopback, link-local,
unique-local, CGNAT and multicast answers. One private answer in a split-horizon
result is enough to refuse. An empty allowlist means nothing is fetchable.

Development fixtures come from `scripts/seed/product-2-2-dev-seed.js`, which is
idempotent and refuses to run unless `NODE_ENV` is `development` or `test`. There
is no automatic seeding anywhere in the server bootstrap. Run it explicitly:

```
NODE_ENV=development npm run seed:product-2-2:dev
```

The three synthetic public titles and their localizations are marked
`EDITOR_VERIFIED`: that describes the fixture author's explicit local assertion,
not provider verification. The made-up Steam and Google Play identifiers are
stored only as `game_identity_claims` with
`claim_source = development_fixture_unverified`; the seed creates zero
`game_external_identities`. Its fixture article remains `DRAFT`, reuses revision
1, and sets `editorial_articles.current_revision_id` to that revision on every
run. The disposable verification gate applies all migrations, runs the documented
command twice consecutively, and compares the complete fixture snapshot:

```
npm run test:postgres:product-2-2:seed
```

## Catalog normalization deployment gate

Persisted `normalized_title` values use the frozen
`unicode-8.0-unorm-1.6.0-data-1.6.17-v1` contract, independent of the host's
Node.js/ICU and PostgreSQL Unicode tables. After migrations and before PM2
restart, the deployment script always runs:

```bash
npm run catalog:normalization:reconcile
```

The reconciler locks `catalog_games` and `game_localizations`, checks for
canonical localization collisions, rewrites drifted rows atomically, and marks
the exact contract ready. The server then re-verifies the marker and every
stored canonical title before it listens. Skipping `prisma migrate deploy` does
not skip reconciliation; if the normalization-state migration is absent, the
deployment fails closed. Characters introduced after Unicode 8 remain
separators until a separately reviewed versioned migration upgrades the
contract.

## Feature flags and analytics

Eight independent kill switches: `openCatalog`, `aiQuickAdd`, `playlog`,
`playCompass`, `gameDNA`, `monthlyReplay`, `todayFeed`, `magazine`.

Each has an environment default (`PRODUCT_FEATURE_<NAME>_ENABLED`, default
`true`) and an optional `product_feature_flags` database override. Flags are read
from the database on every request: a process-local cache would let one instance
keep serving a feature after an operator disabled it, so it cannot be the basis
of a correctness or safety decision. A lookup failure falls back to the
environment defaults, so a flag problem can never take down an endpoint.

`GET /api/v1/product-config` returns a versioned DTO (`dtoVersion`,
`productVersion`) with all eight switches, limits and allowlists.

Product Events are allowlisted in both dimensions: the event code must be
declared, and each property must match a declared shape (`boolean`, bounded
`integer`, fixed `enum`, or slug-shaped `code`). Anything else is dropped before
the row is written, so a raw query, a Playlog note, a URL query string, a provider
body or a prompt cannot reach analytics even if a client sends one. `eventId` is
unique, so a retried batch is reported as a duplicate rather than double counted.

Required codes: `quick_add_preview`, `quick_add_confirm`, `play_compass_submit`,
`play_compass_select`, `play_session_create`, `game_dna_view`, `replay_view`,
`replay_share`, `article_impression`, `article_action`.

## Privacy and security

- Playlog `note` and `mood` values are never logged and never emitted as event
  properties. Only presence flags (`hasNote`, `hasMood`) and enum codes are
  logged.
- No Product 2.2 module logs a raw query, note, input, prompt, provider body, URL
  or title. A repository scan over `src/modules/{catalog,play,feed,product}`
  enforces this, and the scanner is itself tested against planted leaks.
- Editor/admin capability is never taken from a JWT claim.
- Account A cannot read or mutate account B's private sessions or submissions;
  a foreign id is reported as `404`, so ids are not enumerable.
- Correctness never rests on a process-local cache or lock. Uniqueness,
  idempotency and kill-switch state are all database-owned.

### Account deletion policy

| Data | On account deletion | Why |
|---|---|---|
| `PlaySession` (incl. `note`, `mood`) | deleted (FK cascade) | private user content |
| `GameFollow` | deleted (cascade) | private preference |
| `GameSubmission` and its field evidence | deleted (cascade) | tied to the submitter |
| `PlayCompassEvent` | deleted (cascade) | private behavioral signal |
| `UserRoleAssignment` | deleted (cascade) | capability, not a fact |
| `ProductEvent.userId` | set to `NULL`, row retained | keeps aggregate analytics correct without an identifiable subject |
| `EditorialArticle.authorUserId` | set to `NULL`, article retained | a published article is a public record |
| `CatalogGame` contributed by the account | **retained** | a published catalog fact is public, shared data; `createdByUserId` is an audit-only UUID with no foreign key so the fact outlives the account |
| `GameFieldEvidence` on a retained game | **retained** | provenance must survive, or a published fact loses its justification |

A user who wants a contributed *public catalog fact* removed raises a catalog
correction or a takedown request; that is an editorial decision, not an automatic
consequence of account deletion. This asymmetry is deliberate: personal records
are erased, shared facts are not silently rewritten. Verified by
`test/product-2-2/product-2-2.postgres.test.js`.

## Trust model

| Level | What produces it | May back a PUBLISHED game? | May occupy the global provider key? |
|---|---|---|---|
| `PROVIDER_VERIFIED` | a real server-side provider response (Steam owned-games sync, IGDB lookup) | yes | yes, with `verifiedAt` and a `verificationSource` |
| `OFFICIAL_SOURCE` | an allowlisted official source an editor accepted | yes | yes |
| `EDITOR_VERIFIED` | an editor decision, role re-read from the database | yes | yes |
| `USER_CONFIRMED` | a value the user typed or confirmed, including a parsed store URL or package id | no | no — `game_identity_claims` only |
| `AI_INFERRED` | LLM extraction | no | no |
| `UNKNOWN` | a legacy row whose origin cannot be proven | no | no — `game_identity_claims` only |
| `DISPUTED` | a contested fact | no | no |

Ownership provenance on a library row follows the same rule: the Steam owned-games
sync records `PROVIDER_VERIFIED`, a manual `POST /users/me/library/status` records
`USER_CONFIRMED`, and a row that predates provenance tracking is `UNKNOWN`.
`gameSource` is client settable and is never used to infer trust.

Public promotion requires verified provenance on both the title and the identity,
enforced at runtime by `assertPublicationTrust`. A quick-add submission therefore
always produces a `PRIVATE` game owned by the submitter, and requesting public
review only ever reaches `PENDING_REVIEW`.

`game_external_identities` is **verified-only**, and there is no promotion path into
it. An earlier revision kept unverified legacy rows in that table and upgraded one in
place when a real provider response arrived, which meant a user-supplied appid could
be adopted by another account's Steam sync: the attacker's catalog game became the
sync's canonical game, keeping their title, their `PUBLISHED` status and their
`UNKNOWN` provenance. Every unverified row now lives in `game_identity_claims`, which
is unique per *(catalog game, provider, external id, region)* rather than globally, so
a claim cannot squat a key. Four CHECK constraints in
`20260730140000_product_2_2_review_fixes_round_2` make the rule a database property:

- `game_external_identities_verified_provenance_check` — the global table admits only
  `PROVIDER_VERIFIED`, `OFFICIAL_SOURCE` or `EDITOR_VERIFIED`, with `verified_at` and
  `verification_source` both NOT NULL,
- `game_external_identities_verification_source_present_check` — the source must name
  something, not be blank,
- `catalog_games_published_requires_verified_title_check` — a `PUBLISHED` game must
  have verified title provenance,
- `game_identity_claims_unverified_provenance_check` — a claim may never assert
  verified provenance.

A catalog game and its verified identity are created in one transaction, so a failed
identity insert cannot leave a public orphan game behind and a retry cannot duplicate
it.

## Verification

See [`docs/PRODUCT_2_2_VERIFICATION.md`](./PRODUCT_2_2_VERIFICATION.md).

## Known limits

- Install state is not tracked, so Play Compass reports ownership evidence with
  `installEvidence.known: false` rather than inferring installation.
- Genre and Steam-tag signals are sparse until catalog games are enriched: the
  backfill creates canonical games with empty `genres`/`steamTags`, so Game DNA
  reports `genre_signal_missing` / `steam_tag_signal_missing` until then. That is
  reported honestly rather than filled with a guess.
- Catalog search uses bounded prefix and containment scans plus in-process
  ranking. It is correct and deterministic, but a trigram or full-text index
  would be needed before the catalog grows large.
- `GameSubmission.draft` retains AI-extracted structured fields for the preview
  TTL. They are structured candidate fields, not the raw input, and the row
  expires.

## Risk register additions

| ID | Severity | Risk | Current control | Remaining action |
|---|---|---|---|---|
| R-P22-CATALOG-DUPLICATE | Medium | two canonical games for one work while no CONFIRMED mapping exists | fuzzy candidates surfaced for human confirmation; identity conflicts reported not merged | editor merge tooling and a review queue UI |
| R-P22-AI-DRIFT | Medium | a model returns plausible but wrong metadata | strict Zod contract, AI_INFERRED provenance, no auto publish, human confirmation | sample-based accuracy review once real traffic exists |
| R-P22-CATALOG-SEARCH-SCALE | Medium | bounded prefix/containment scans degrade as the catalog grows | bounded scan limits and deterministic ranking | add a trigram or full-text index before the catalog grows large |
| R-P22-SOURCE-ALLOWLIST | Medium | an operator adds a host that later serves attacker-controlled redirects | HTTPS-only, no redirect following, DNS public-address check, size and time bounds | document an allowlist review cadence with the operator |
| R-P22-EVENT-ALLOWLIST-DRIFT | Low | a new event property is added without a shape rule and is silently dropped | dropped keys are returned by name in the response and counted in logs | monitor `droppedPropertyCount` after each client release |
| R-P22-METADATA-SPARSITY | Low | Game DNA and Play Compass are weak until catalog genres and tags are enriched | missing signals are reported explicitly, never guessed | catalog enrichment backfill from IGDB/Steam metadata |
| R-P22-DELETION-ASYMMETRY | Low | a user expects a contributed public catalog fact to vanish with their account | documented policy plus audit-only attribution without a foreign key | operator-owned takedown path for contributed catalog facts |
