# GamePedia 2.0 Backend Cross-Platform Contract

The machine-readable source is `openapi/cross-platform.openapi.json`. It covers only the mobile gate subset.

Product 2.2 (the Play Intelligence slice) is a **separate additive contract** in
`openapi/product-2.2.openapi.json`, mounted entirely under `/api/v1`. It changes
nothing in this document: every operation below keeps its current unversioned
path, behavior and response shape. See `docs/PRODUCT_2_2_SERVER.md`.

| Operation | Canonical behavior | Compatibility |
|---|---|---|
| Recent plays | `GET /users/me/recently-played?limit=1..50`; omitted or strict integer only, malformed/out-of-range values return `400 INVALID_RECENT_PLAY_LIMIT`; UTC/null dates; four equivalent list keys | `/users/me/recent-plays` is deprecated after released clients migrate |
| Privacy | `GET/PATCH /users/me/privacy`; canonical `show*` keys | `/privacy-settings` and iOS `is*Public` keys remain supported; contradictory dual keys are rejected |
| Steam status | `GET /users/me/steam`; DB-only, nullable profile fields | exact iOS DTO fields supplied; no provider call |
| Steam friends | `POST /users/me/friends/steam/import` | discovery refresh only; no automatic friendship creation |
| Friend recommendations | `/users/me/recommendations/friends` for all friends; `/users/{userId}/friend-recommendations` for one accepted friend's visible signals | non-friend/blocked access is rejected |
| Push token | PUT canonical, POST compatibility; DELETE accepts body or deployed iOS query | conflicting body/query identifiers are rejected |
| Refresh | `POST /auth/refresh`; exactly one concurrent successor | loser/replay: `401 TOKEN_REVOKED` |

Removal of deprecated aliases requires released-client migration, privacy-safe telemetry below an owner-approved threshold, an observation period, owner approval, contract-test changes, a rollback path, and only then a documented Sunset date.
