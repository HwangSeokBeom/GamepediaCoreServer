# Authentication Cross-Platform Contract (iOS 2.0 / Android)

The machine-readable source is `openapi/cross-platform.openapi.json` (auth paths under `/auth/*`). This document explains the semantics that the schema alone cannot carry. There is exactly ONE canonical contract; iOS and Android consume the same endpoints, envelopes, and error codes with no platform-specific forks.

## Envelope

Every auth endpoint uses the shared envelope:

- Success: `{"success": true, "data": ...}`
- Failure: `{"success": false, "error": {"code", "message", "details"?}}`

Clients must branch on `error.code`, never on `error.message` (messages are sanitized and may be localized). No response ever contains internal error text, Prisma errors, SQL, filesystem paths, stack traces, or token material outside the documented `tokens` fields.

## Endpoints

| Endpoint | Success | Session issued | Notes |
|---|---|---|---|
| `POST /auth/signup` | `201 {user, tokens}` | yes | `409 EMAIL_ALREADY_IN_USE` / `NICKNAME_ALREADY_EXISTS`, stable under concurrency |
| `POST /auth/login` | `200 {user, tokens}` | yes | `401 INVALID_CREDENTIALS` is identical for unknown email and wrong password |
| `POST /auth/apple` | `200 {user, tokens}` | yes | first login links by verified email or creates an account |
| `POST /auth/google` | `200 {user, tokens}` | yes | email link only when authoritative (verified gmail.com or hosted domain), else `409 GOOGLE_ACCOUNT_LINK_CONFLICT` |
| `POST /auth/refresh` | `200 {user, tokens}` | yes (rotated) | single-use token; loser/replay: `401 TOKEN_REVOKED` |
| `POST /auth/logout` | `200 {loggedOut: true}` | no | idempotent; revokes only the presented session |
| `POST /auth/forgot-password` | `200 {message}` | no | fixed response; never reveals account existence |
| `POST /auth/reset-password` | `200 {passwordReset: true}` | no | single-use token; deletes ALL refresh sessions |
| `GET /auth/me` | `200 {user}` | no | bearer access token; re-checks account existence and status |
| `DELETE /auth/me` | `200 {deleted, deletedAt}` | no | deletes account and every session transactionally |

`GET /users/me` (profile module) also exists and is a richer profile endpoint; account/session lifecycle is owned by `/auth/me`.

## Client / server responsibility boundary

Server owns (and clients must NOT re-implement):

- Authenticating the presented refresh token (signature, `type`, subject-vs-record match, expiry, revocation, account status).
- Atomically claiming the refresh-token record: at most one successor per token, ever, across any number of processes (database compare-and-swap; see `AUTH_CONCURRENCY_INVARIANTS.md`).
- Rejecting replay with the stable code `TOKEN_REVOKED`.
- Storing only SHA-256 hashes of refresh and password-reset tokens — never raw values.
- Idempotent logout and transactional account deletion / password reset session invalidation.
- Transaction-safe social account linking (one link per provider subject under concurrency).
- The shared envelope, stable error codes, and redacted logging.

Client owns (and the server intentionally does NOT implement):

- Single-flight coordination so one local caller refreshes at a time.
- Preventing multiple local callers from reusing the same rotating token, and rejecting a late refresh result after a newer local session was adopted (local session generation counters).
- Local cancellation semantics.
- Secure at-rest token storage (Keychain / Android Keystore-backed storage).

The server guarantees that a client which loses one of these local races still fails safely: the losing request receives `401 TOKEN_REVOKED` and no second successor exists.

## Semantics clients rely on

- **Refresh success returns both `user` and the rotated `tokens`.** Clients may refresh their cached profile from it.
- **`TOKEN_REVOKED` is permanent** for that token: already consumed (replay), concurrent loser, logged out, or invalidated by password reset. The client should discard the session and re-authenticate unless it just adopted the winning successor.
- **`TOKEN_EXPIRED`** covers both JWT expiry and database-row expiry.
- **`UNAUTHORIZED`** on refresh means the token is structurally invalid (bad signature, wrong `type`, subject mismatch).
- **`404 ACCOUNT_NOT_FOUND`** on refresh/me means the account no longer exists (e.g. deleted); `403 ACCOUNT_INACTIVE` / `ACCOUNT_SUSPENDED` are stable status failures.
- **Logout is idempotent**: repeated, unknown, or already-revoked tokens all return `200 {loggedOut: true}`. Logout revokes ONLY the presented session (single-device logout); other devices stay signed in. This is the documented multi-device policy: each login/signup/social login issues an independent session and does not revoke earlier ones.
- **Account deletion** (`DELETE /auth/me`) removes all refresh sessions in the same transaction as the user row; afterwards refresh returns `ACCOUNT_NOT_FOUND` and access tokens fail middleware lookup.
- **Password reset** deletes all refresh sessions atomically with the password change.
- **`deviceName`** is optional on session-issuing endpoints, trimmed, 1–100 characters, and rejects `null`. On refresh, omitting the field preserves the rotated session's previous label.
- **Dates** serialize as ISO-8601 UTC (`...Z`). `profileImageUrl` is `string | null`.

## Error-code stability

The full list of auth error codes is documented on the `ErrorResponse` schema in the OpenAPI file. Codes are append-only; renaming or removing a code is a breaking contract change and requires the deprecation process in `docs/CROSS_PLATFORM_CONTRACT.md`.
