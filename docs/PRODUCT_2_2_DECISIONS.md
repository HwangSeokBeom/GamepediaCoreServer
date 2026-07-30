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

- Status: partially superseded by "An unreadable kill-switch state is treated as
  off" below. The per-request database read stands; the fallback behavior on a
  lookup *failure* was wrong and is corrected there.
- Context: an operator disabling a feature, or revoking an editor role, must take
  effect immediately across every instance.
- Decision: `product_feature_flags` and `user_role_assignments` are queried on
  each request. A JWT role claim is never trusted. (The original wording continued
  "a flag lookup failure falls back to environment defaults so a flag problem
  cannot take down an endpoint" — that reasoning was wrong, because every default
  is `true`, so the fallback silently re-enabled disabled features. See the
  superseding entry.)
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

## 2026-07-30 — Review corrections: a user-supplied value is a claim, not a fact

- Status: accepted
- Context: the independent review found that `ensureCanonicalGameForIdentity`
  defaulted to `PUBLISHED` + `PROVIDER_VERIFIED`, that quick add attached a
  syntax-parsed provider key as a verified global identity with confidence 1, and
  that Play Compass inferred provider-verified ownership from
  `gameSource === 'STEAM'`. Any authenticated user could therefore publish a
  catalog game, mint a verified identity, or squat an unregistered Steam / App
  Store / Google Play id and capture another account's future real provider sync.
- Decision: only a real server-side provider response or an editor decision can
  produce a verified identity or a publicly visible catalog fact. Every trust
  field on the creation path is mandatory and there are no trust defaults;
  `assertPublicationTrust` is a runtime invariant. Unverified claims live in
  `game_identity_claims`, scoped per catalog game and deliberately not globally
  unique, so a claim cannot block or capture a verified attachment. Ownership
  provenance is stored on the library row and read from storage, never inferred
  from `gameSource`.
- Alternatives: keeping claims in `game_external_identities` behind a
  `verified` flag (rejected: the globally unique key is exactly what a squatter
  needs, and a partial unique index would still let the first claimant hold the
  slot); trusting `gameSource` (rejected: a client sets it on a manual write).
- Consequences: a manual library / review / favorite write that names an
  unverified provider id leaves `catalogGameId` null. That is visible as "not
  linked yet" rather than a fabricated link, and a later real provider sync links
  it. Legacy backfilled identities were corrected to `UNKNOWN`, so some catalog
  games are `PENDING_REVIEW` until a provider response or an editor confirms them.
- Verification impact: the PostgreSQL gate asserts no identity claims
  `PROVIDER_VERIFIED` without a `verifiedAt`, no synthetic placeholder title stays
  `PUBLISHED`, no legacy library row asserts provider ownership, and that an
  attacker's claim does not capture a victim's real Steam sync.

## 2026-07-30 — A PostgreSQL transaction cannot absorb a constraint violation

- Status: accepted
- Context: the first version of the atomic idempotency fix wrapped the receipt
  insert and the mutation in one transaction and caught `P2002` to detect a
  replay. Under six concurrent retries five of them failed with an opaque error.
  PostgreSQL aborts the whole transaction when a statement raises (SQLSTATE
  25P02), so the follow-up read after the catch could never execute. Mocked tests
  passed; only the real database exposed it.
- Decision: claim inserts inside a transaction use
  `INSERT ... ON CONFLICT DO NOTHING RETURNING id`, which never raises. A returned
  row means this caller owns the mutation; no row means a genuine replay. A
  competing uncommitted row makes the statement block until that transaction
  settles, which gives the correct answer in both directions.
- Alternatives: a `SAVEPOINT` around each insert (rejected: more moving parts for
  the same guarantee); check-then-insert (rejected: still races, and the loser
  still aborts its transaction).
- Consequences: two claim inserts are raw SQL rather than Prisma delegate calls.
  They are covered by both a source assertion and real-database concurrency tests.
- Verification impact: `npm run test:postgres:product-2-2` runs ten concurrent
  quick-add confirms and six concurrent deletes sharing one key.

## 2026-07-30 — Normalization must preserve every script, and marks are letters

- Status: accepted
- Context: the shipped normalizer retained only ASCII, Hangul, Hiragana, Katakana
  and CJK ideographs. Thai, Arabic, Cyrillic, Hebrew, Greek, Devanagari and
  Vietnamese titles normalized to an empty string, which made them unstorable and
  unsearchable, and it split `Pokémon` on its accent and `ゲーム` on the prolonged
  sound mark.
- Decision: NFKC, then treat only non-letter/non-number/non-retained-mark runs as
  separators. Combining marks are retained because they are load-bearing —
  dropping U+0E34 collapses Thai `กิน` to `กน`. PostgreSQL classifies marks as
  `[:punct:]`, so the retained set is whitelisted explicitly, and
  `RETAINED_MARK_RANGES` is the single source rendered into both the JS regex and
  the SQL bracket expression. Trademark symbols are stripped before NFKC because
  NFKC folds U+2122 into the letters `TM`.
- Alternatives: dropping marks to match `[:alnum:]` (rejected: it collapses
  distinct words in Thai and Devanagari); NFC instead of NFKC (rejected: fullwidth
  and Roman-numeral forms would stop folding).
- Consequences: slugs may be non-ASCII, which is what keeps a Thai or Cyrillic
  title addressable. A stored title's normalization depends on the shared mark
  whitelist, so changing it requires a new successor migration.
- Verification impact: a unit test asserts the migration embeds the rendered mark
  class verbatim; the PostgreSQL gate proves byte-level JS/SQL parity over a
  multi-script corpus and asserts no alphanumeric title normalized to empty.

## 2026-07-30 — An unreadable kill-switch state is treated as off

- Status: accepted
- Context: a feature-flag lookup failure fell back to the environment defaults,
  and every default is `true`, so a database problem could silently re-enable a
  feature an operator had disabled.
- Decision: an environment default applies only when the lookup succeeded and had
  no row for that key. A lookup failure reports every gated feature as false with
  source `database_unavailable`, and `requireFeature` returns 503
  `FEATURE_STATE_UNAVAILABLE`, distinct from `FEATURE_DISABLED` and retryable.
- Alternatives: retrying the lookup (deferred: it does not change what to do when
  the retry also fails); serving the last known state from memory (rejected: a
  process-local cache cannot be the basis of a safety decision).
- Consequences: a database outage disables Product 2.2 features rather than
  exposing them. Pre-existing unversioned endpoints do not consult these flags and
  are unaffected.
- Verification impact: unit tests assert all-false plus a degraded source, and the
  PostgreSQL gate flips a real flag row and observes it without a restart.

## 2026-07-30 — Changing published content is an audited correction

- Status: accepted
- Context: a `PUBLISHED` article could be edited immediately with no status change
  and no trace, and `bodyMarkdown` was written to revisions but never read, so the
  public endpoint returned an article with no body.
- Decision: one `appendRevision` path appends a revision and atomically points the
  article at it; an omitted body carries the previous one forward and only an
  explicit null clears it. Changing content that is already public requires status
  `CORRECTED` with a non-empty `changeNote` and sets `correctedAt`. The body is
  CommonMark with HTML disabled, rejected at the validator rather than sanitized
  later.
- Alternatives: sanitizing HTML on render (rejected: the stored value would still
  contain markup, and every future reader would depend on the sanitizer).
- Consequences: an editor cannot quietly fix a typo in a live article; it becomes a
  visible correction. That is the intended trade.
- Verification impact: the PostgreSQL gate drives the full lifecycle — draft,
  three transitions, publish, silent-edit refusal, correction, retraction — and
  asserts the body survives all of it.

## 2026-07-30 — The global identity table is verified-only

- Status: accepted
- Context: the round-1 fix demoted overstated legacy provenance but left the rows in
  `game_external_identities` so a later real provider response could "promote" one in
  place. That promotion was the capture: a user-supplied appid on an attacker's
  catalog game was adopted by the victim's real Steam sync, which then returned the
  attacker's game with their title and their publication status intact. The round-1
  migration also only demoted synthetic `PROVIDER:id` titles, so a legacy title that
  merely looked like a real game name stayed publicly searchable with `UNKNOWN`
  provenance, and `game_localizations` kept a `PROVIDER_VERIFIED` provenance it never
  earned.
- Decision: `game_external_identities` admits only verified rows, enforced by CHECK
  constraints plus NOT NULL on `verified_at` and `verification_source`. Every
  unverified row moves to `game_identity_claims`. There is no promotion path: a
  verified sync creates its own canonical game. The demotion rule is the provenance,
  not the shape of the string, and it cascades to localizations.
- Alternatives: keeping unverified rows and requiring callers to check
  `verified_at` (rejected: the previous revision did exactly that and one caller
  passing `requireVerified: false` was enough to reopen the hole); a runtime-only
  guard (rejected: a future code path, a manual fix or a bad migration can bypass
  application code, so the invariant belongs in the database).
- Consequences: a legacy library row may point at a canonical game that has no
  verified identity. That is accurate and is what the claim table records. It also
  means a fixture that creates a `PUBLISHED` game must state a verified title
  provenance, which is why several test fixtures changed.
- Verification impact: the attack is performed against a real database in
  `test/product-2-2/round-2-attacks.postgres.test.js`, all five unverified-identity
  shapes are rejected with SQLSTATE 23514/23502, and
  `scripts/test/verify-product-2-2-backfill.sql` asserts the migrated legacy fixture
  ends in the intended state.

## 2026-07-30 — Editorial mutations hold a row lock for the whole unit of work

- Status: accepted
- Context: `updateArticle`, `publishArticle` and `retractArticle` read the status,
  the current revision and the asset rights outside any transaction and then updated
  by id. An editor who read `SCHEDULED` could edit an article another editor had
  since published, with no `CORRECTED` status, no `correctedAt` and no `changeNote`;
  and a publish could pass its hero-rights check while another transaction added an
  unresolved hero asset.
- Decision: every mutation is one transaction that begins with
  `SELECT ... FOR UPDATE` on the article, then re-reads status, revision and assets,
  then re-checks the actor's role in the database. `expectedRevisionNumber` is
  available as an explicit optimistic check on top, returning
  `ARTICLE_CONCURRENT_MODIFICATION`.
- Alternatives: a process-local mutex (rejected: it does not survive more than one
  server process, which is how this service runs); an updatedAt comparison in the
  WHERE clause (deferred: it detects the lost update but still leaves the rights
  check reading a stale snapshot).
- Consequences: editorial writes serialize per article. That is acceptable — they
  are human-paced — and it is the only way the decision can be made on a state no
  concurrent writer can change.
- Verification impact: a real two-connection edit-versus-publish race and a
  mid-request hero-asset insertion are both driven against PostgreSQL.

## 2026-07-30 — A public article's contract is enforced, not merely documented

- Status: accepted
- Context: an article with `bodyMarkdown: null` could be `PUBLISHED`, and a
  status-only hop to `CORRECTED` wrote an audit revision with `changeNote: null`,
  while the OpenAPI document said both were non-null. The Markdown validator was a
  regular expression that accepted every image form, so a CommonMark image node
  bypassed the `ArticleAsset` rights review and a published article could load a
  third-party resource that reports a reader's IP address on open.
- Decision: fix the server rather than weaken the contract. Publishing requires a
  non-empty body; a correction requires a non-empty note and an actual visible
  change; `appendRevision` refuses a `CORRECTED` revision with no note. `mapArticle`
  splits into `PublicArticle` (throws rather than serving a degraded shape),
  `EditorArticle` (nullable draft body plus internal metadata) and `ArticleSummary`
  (no body, for Today cards). Body validation walks a real CommonMark AST with an
  allowed-node set and an https-only scheme set, at the write boundary and again at
  publish time.
- Alternatives: marking `bodyMarkdown` nullable in OpenAPI (rejected: it documents
  the defect instead of fixing it, and pushes the problem into every client);
  extending the regular expression (rejected: reference-style images, angle-bracket
  destinations and `data:` URLs are three separate escapes, and the next syntax would
  be a fourth).
- Consequences: `commonmark` is a new runtime dependency (BSD-2-Clause). Only its
  `Parser` is used; the bundled HTML renderer is never touched. A rejection carries
  reason codes only, so neither a response nor a log line can echo a tracking URL.
- Verification impact: twelve image syntaxes, seven raw-HTML positions and eleven
  refused link destinations at the unit level; at the database level a body written
  directly to the table is still refused at publish, and a SQL sweep confirms no
  publicly readable article has an empty body or a noteless correction.

## 2026-07-30 — Text length is measured in Unicode code points

- Status: accepted
- Context: `normalizeTitle` truncated with `slice(0, 300)`, which counts UTF-16 code
  units, while PostgreSQL `varchar(300)` and `left(text, 300)` count characters.
  `'a' + '\u{20BB7}'.repeat(200)` is 201 code points; the JavaScript side kept 151 and
  ended in an unpaired high surrogate, the SQL side kept all 201. The validated value
  and the stored value disagreed, and a lone surrogate could be persisted.
- Decision: `src/utils/unicode-text.js` measures and truncates by code point, and
  every title, slug, discriminator and bounded text field goes through it.
  `truncateCodePoints` iterates with `for..of`, so a boundary never falls inside a
  surrogate pair.
- Alternatives: widening the columns (rejected: it moves the boundary without making
  the two sides agree); rejecting astral characters (rejected: they are ordinary
  characters in Japanese and Chinese titles).
- Consequences: parity is asserted over a named corpus, not over all of Unicode. The
  residual risk — the two engines' NFKC tables coming from different Unicode versions
  — is recorded in `docs/PRODUCT_2_2_VERIFICATION.md` rather than claimed away.
- Verification impact: the corpus is stored in a real `varchar(300)` column, and
  `char_length` is compared with `countCodePoints` and `left(value, 300)` with
  `clampTitle(value)` for every entry.
