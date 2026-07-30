# Product 2.2 — Technical Decisions

Append-only. "Product 2.2" is this product slice, not the 2.2 of any earlier
technical roadmap.

## 2026-07-30 — Canonical catalog is additive; legacy identity stays authoritative

- Status: accepted
- Context: reviews and favorites key games by a bare IGDB id string, the library
  keys them by `(gameSource, externalGameId)`, and activity events carry both plus
  an `igdbGameId`. A deployed iOS client depends on all of it.
- Decision: add `CatalogGame` with a UUID id and a nullable `catalog_game_id`
  column on the four legacy tables. Legacy columns remain the source of truth;
  `catalogGameId` is an additional canonical index. New writes dual-write, and the
  dual-write hooks are best effort so a catalog failure cannot break an existing
  endpoint.
- Alternatives: adding `MANUAL` to the `GameSource` enum (rejected: it conflates a
  provider with a registration method and cannot express a regional edition);
  rewriting legacy columns to canonical ids (rejected: breaks deployed clients).
- Consequences: two identity systems coexist until a separately reviewed
  deprecation. Reads that need canonical identity must resolve through
  `game_external_identities`.
- Verification impact: `npm run test:postgres:product-2-2` Phase B upgrades a
  legacy schema with fixture data and asserts the backfill.

## 2026-07-30 — Only CONFIRMED Steam↔IGDB mappings may merge

- Status: accepted
- Context: `steam_igdb_mappings` holds `CONFIRMED`, `CANDIDATE`, `UNMATCHED` and
  `REJECTED` rows with a confidence score. Merging on score would silently fuse
  distinct games.
- Decision: the backfill merges only `match_status = 'CONFIRMED'`. A merge
  repoints the Steam identity, leaves the source game as a tombstone, and writes a
  `CatalogMergeAudit` row. Everything else stays separate. At runtime, a provider
  key already bound to another canonical game is reported as a conflict for review
  rather than repointed.
- Alternatives: merging above a confidence threshold (rejected: a false merge is
  much harder to undo than a missing one); deleting the collapsed row (rejected:
  historical ids must stay resolvable).
- Consequences: some genuinely identical games stay split until a mapping is
  confirmed. Reads must resolve through the tombstone chain.
- Verification impact: gate checks 1–5 plus a `REJECTED` same-title fixture pair.

## 2026-07-30 — AI output is a suggestion, never a source

- Status: accepted
- Context: quick add must handle games absent from IGDB and Steam, which means an
  LLM sees untrusted user text and untrusted provider page descriptions.
- Decision: deterministic parsing and catalog matching run first and
  short-circuit. The model is consulted last, its completion is parsed by a strict
  Zod contract, and every field it produces is pinned to `AI_INFERRED`. AI can
  never publish or merge. Any failure degrades to a minimal manual draft.
- Alternatives: trusting a model-supplied provenance field (rejected: it is the
  one field an adversarial completion would forge); failing the request on AI
  error (rejected: quick add must work without AI).
- Consequences: a draft may be sparse. The client must collect the missing fields.
- Verification impact: `catalog-submission.test.js` covers malformed bodies, four
  skip reasons, a thrown client error, and provenance pinning.

## 2026-07-30 — The raw natural-language input is never persisted

- Status: accepted
- Context: an early implementation used the raw input as the draft title when AI
  extraction produced nothing. That put unconfirmed user free text into the
  database on every preview.
- Decision: store only a SHA-256 fingerprint plus structured fields. When no
  structured title exists, the draft keeps `originalTitle: null` and
  `requiresTitleConfirmation: true`, and confirmation must supply the title
  (`SUBMISSION_TITLE_REQUIRED`).
- Alternatives: storing the input with a short TTL (rejected: it is still
  persistence of unconfirmed free text, and TTL enforcement is a separate job).
- Consequences: a client cannot rely on the server to remember what the user
  typed; it must keep the input locally until confirmation.
- Verification impact: a privacy test asserts the persisted row contains neither
  the input nor any distinctive fragment of it.

## 2026-07-30 — Sentinel values instead of NULL inside compound unique keys

- Status: accepted
- Context: `GameLocalization` originally had a nullable `region_code` inside a
  five-column unique key. PostgreSQL treats every `NULL` as distinct, so that
  constraint would never have prevented duplicate original-title rows. It was
  found when an idempotent upsert could not target the NULL row at all.
- Decision: `region_code` and `region_key` are `NOT NULL` with a `'GLOBAL'`
  default. A test asserts that no compound unique key added by Product 2.2
  contains a nullable column.
- Alternatives: a partial unique index per nullability case (rejected: two indexes
  to express one rule, and upserts still cannot target it).
- Consequences: `'GLOBAL'` is a meaningful value that read paths must handle, not
  an absence.
- Verification impact: `catalog-migration.test.js` unique-key scan; seed
  idempotency confirmed on a real database.

## 2026-07-30 — Play intelligence is deterministic; AI is optional narration

- Status: accepted
- Context: Game DNA, Play Compass and Monthly Replay drive a decision the user
  acts on. A non-reproducible answer cannot be debugged or trusted.
- Decision: all three are computed deterministically with total orderings on every
  sort. Explanations are allowlisted reason codes, never free text. Play Compass
  draws only from owned `PLAYING`/`BACKLOG` entries and returns at most three
  picks with ownership evidence. AI narration, if added, is additive and optional.
- Alternatives: an LLM ranker (rejected: not reproducible, and it would put the
  user's private library in a prompt on every request).
- Consequences: recommendation quality is bounded by available structured
  metadata; sparse signals are reported rather than guessed.
- Verification impact: determinism is asserted by re-running with reversed input
  order and comparing output.

## 2026-07-30 — Timezone windows are computed by inverting the zone offset

- Status: accepted
- Context: the calendar and Monthly Replay aggregate by local day. Adding a fixed
  offset misplaces sessions across a DST transition and produces 23- or 25-hour
  local days.
- Decision: convert local wall time to UTC by re-reading the zone offset at the
  candidate instant and iterating to convergence, using `Intl.DateTimeFormat`
  parts. Month windows are half-open `[start, end)` at local midnight.
- Alternatives: a timezone library (rejected: `Intl` already carries the IANA
  database and this adds no dependency); storing local dates (rejected: the
  timezone becomes a per-row fact that cannot be re-interpreted).
- Consequences: two or three `Intl` formats per boundary computation; formatters
  are cached per zone.
- Verification impact: explicit spring-forward and fall-back assertions, including
  the 31×24h∓1 span, and boundary-day date keys.

## 2026-07-30 — Kill switches and roles are read from the database per request

- Status: accepted
- Context: an operator disabling a feature, or revoking an editor role, must take
  effect immediately across every instance.
- Decision: `product_feature_flags` and `user_role_assignments` are queried on
  each request. A JWT role claim is never trusted. A flag lookup failure falls
  back to environment defaults so a flag problem cannot take down an endpoint.
- Alternatives: an in-process TTL cache (rejected: a stale cache would keep
  serving a killed feature, so it cannot be the basis of a safety decision);
  Redis (deferred: no shared store is a hard dependency yet).
- Consequences: one extra indexed lookup per Product 2.2 request.
- Verification impact: `product-2-2.postgres.test.js` flips a flag and revokes a
  role and observes both on the next read, with no restart.

## 2026-07-30 — Analytics and editorial sources are allowlist-only

- Status: accepted
- Context: an events endpoint that accepts arbitrary properties becomes an
  exfiltration path for search queries and Playlog notes. An ingest endpoint that
  fetches arbitrary URLs becomes an SSRF primitive.
- Decision: Product Events allowlist both the event code and each property's
  shape, dropping everything else; a `code` property must be slug-shaped so a
  sentence or URL cannot pass. Source fetching requires an administrator-configured
  host allowlist, HTTPS, a bounded timeout and size, no redirect following, and a
  DNS check rejecting non-public addresses. User-supplied URLs are never fetched.
- Alternatives: denylisting sensitive keys (rejected: a denylist fails open on the
  next new key).
- Consequences: adding an event property or a publisher is a reviewed code change.
- Verification impact: hostile-property and SSRF suites, plus a repository-wide log
  scan whose scanner is itself tested against planted leaks.
