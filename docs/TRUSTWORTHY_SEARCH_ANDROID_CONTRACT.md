# Trustworthy Search — Android Contract Requirements

Scope: contract requirements only. No Android code lives in this repository. The machine-readable source of truth is `openapi/cross-platform.openapi.json`; this page summarizes what an Android client must implement to reach parity with iOS 2.0. Verified against `src/modules/igdb/igdb.routes.js`, `igdb.validator.js`, `igdb.service.js`, `igdb.mapper.js`, and the HTTP contract tests in `test/games-search-contract.test.js`.

## Required endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /games/search?q=<keyword>&limit=<1..30>` | None (public) | Full search results for the results screen |
| `GET /games/suggestions?q=<keyword>&limit=<1..8>` | None (public) | Compact typeahead suggestions while typing |

Both endpoints ignore `Authorization` headers entirely — do not gate search behind login, and do not treat a 401 as possible here (it is not emitted).

## Request rules

- `q` is required, trimmed server-side, and must be 1–100 characters after trimming. Send the user's raw input; the server owns normalization, alias resolution, and language handling.
- `limit` is optional: default 20 / max 30 for search, default 6 / max 8 for suggestions. Out-of-range or non-integer values are a `400`, not a clamp — validate client-side before sending.
- Unknown query parameters are stripped server-side; do not rely on extras.

## DTO contracts

All success bodies are wrapped: `{ "success": true, "data": ... }`.

`GET /games/search` → `data`:

| Field | Type | Notes |
|---|---|---|
| `query` | string | Original trimmed query |
| `games` | `GameListItem[]` | Canonical list, at most `limit` items — **bind Android UI to this field** |
| `results` | `GameListItem[]` | Byte-identical duplicate of `games`; iOS 2.0 compatibility alias. Do not use on Android |
| `suggestions` | `GameSuggestionItem[]` | ≤ 8 companion suggestions |
| `meta` | `SearchMeta` | See below |

`GET /games/suggestions` → `data`: `{ suggestions: GameSuggestionItem[], meta: SearchMeta }`.

`GameListItem`: `id` (int, IGDB id), `name`, `summary`, `coverUrl` (nullable strings; `coverUrl` is absolute https), `genres`/`platforms` (string arrays, possibly empty), `rating`/`aggregatedRating`/`totalRating` (nullable numbers), `releaseDate` (nullable Unix seconds). Every key is always present; model nullability explicitly (Moshi/kotlinx-serialization nullable types, no defaults that hide server nulls).

`GameSuggestionItem`: `id` (int), `name`, `coverUrl`, `rating` (nullable).

`SearchMeta`: `originalQuery`, `normalizedQuery`, `effectiveQuery` (strings), `resultCount` (int, count of the returned list after `limit`).

## Pagination

There is none. Both endpoints are single-page, limit-only; there is no cursor, offset, or total count. `meta.resultCount` equals the returned list length. Android must not implement infinite scroll against these endpoints; request `limit=30` at most and treat the list as complete.

## Error handling

All failures are `{ "success": false, "error": { "code", "message", "details"? } }`. Branch on `error.code` only — `message` is sanitized, may be localized (Korean defaults exist), and is not stable.

| HTTP | `error.code` | Android behavior |
|---|---|---|
| 400 | `INVALID_SEARCH_QUERY` | Should be prevented client-side (empty/blank/>100 chars); show inline input error |
| 400 | `INVALID_GAMES_LIMIT` | Client bug — fix the request; never user-visible |
| 400 | `VALIDATION_ERROR` | Generic validation fallback; treat like the above |
| 429 | `IGDB_RATE_LIMITED` | Provider cooldown. Back off (no immediate auto-retry), keep showing last cached results, offer manual retry |
| 502 | `IGDB_UPSTREAM_ERROR`, `TWITCH_AUTH_UNAVAILABLE` | Transient provider failure. Show a retryable "search unavailable" state; a single delayed retry is acceptable |
| 500 | `IGDB_NOT_CONFIGURED`, `INTERNAL_SERVER_ERROR` | Non-retryable in-session; show generic failure state |

Validation `details` is an array of `{ field, message }` — usable for logging/QA, not for UI copy. An empty `games`/`suggestions` array with HTTP 200 is a normal "no results" state, never an error.

## Caching expectations

- The server caches search and suggestion responses per normalized candidate set for ~10 minutes and may serve cached data during provider rate limits. Responses carry no cache headers; treat them as uncacheable at the HTTP layer.
- Client caching should be short-lived and in-memory only (e.g., LRU keyed by `normalizedQuery` + `limit`, ≤ 10 minutes), primarily to debounce typeahead. Do not persist search responses to disk.
- Debounce suggestion requests (~300 ms) and cancel in-flight requests when the query changes; the server does not deduplicate concurrent identical requests per client.

## Privacy requirements (parity with backend policy)

Do not log raw search keywords, user identifiers, or full request URLs containing `q` in Android analytics/crash logs. The backend itself only persists hashed queries and counts; the client must not weaken this by logging plaintext queries on-device or to third-party SDKs.
