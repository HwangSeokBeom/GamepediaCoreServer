# Authentication Concurrency Invariants

These invariants are enforced in PostgreSQL, not in process memory, so they hold across any number of Node processes sharing the database. The authoritative proof is `npm run test:postgres` (`test/auth-refresh-postgres.integration.test.js`), which runs against a real PostgreSQL database.

## Refresh rotation (single-use tokens)

Sequence in `authService.refresh` (`src/services/auth.service.js`):

1. Verify the JWT signature and `type: "refresh"` with the refresh secret; map failures to `TOKEN_EXPIRED` / `UNAUTHORIZED`.
2. Look up the token by unique SHA-256 hash (`refresh_tokens.token_hash`), including the owning user.
3. Reject: unknown hash (`TOKEN_REVOKED`, or `ACCOUNT_NOT_FOUND` when the subject's account is gone), subject mismatch (`UNAUTHORIZED`), `revokedAt` set (`TOKEN_REVOKED`), row expired (`TOKEN_EXPIRED`), non-ACTIVE user (`ACCOUNT_INACTIVE`/`ACCOUNT_SUSPENDED`).
4. In ONE transaction:
   - **Compare-and-swap claim**: `updateMany` on the exact row `WHERE id = ? AND revoked_at IS NULL AND expires_at > now()`, setting `revoked_at`. Under READ COMMITTED, a concurrent claimer blocks on the row lock and re-evaluates the predicate after the winner commits, so its `count` is `0`.
   - `count !== 1` → `401 TOKEN_REVOKED` (the transaction writes nothing).
   - `count === 1` → insert the successor row (hash only) and return `{user, tokens}`.
5. A foreign-key failure inserting the successor (user deleted concurrently) rolls the claim back and maps to `404 ACCOUNT_NOT_FOUND` — a token is never left revoked-without-successor by a failed rotation.

Invariants proven by the integration suite:

- For N concurrent rotations of one token, exactly one succeeds; every loser gets `TOKEN_REVOKED`.
- Exactly one active (`revoked_at IS NULL`) successor remains.
- The consumed token can never rotate again; the successor rotates exactly once.
- A failure inside the transaction (successor issuance throws) leaves the original token unconsumed.
- The suite was validated for sensitivity: reverting the claim to an unconditional `update` makes the concurrency test fail (double issuance reproduces).

## Logout

- `updateMany WHERE token_hash = ? AND revoked_at IS NULL` — idempotent by construction; repeated/unknown/malformed tokens return the same success without leaking internals.
- Scope: only the presented token. Possession of the refresh token is the authorization; hashes are unique, so another user's token cannot be addressed.

## Account deletion

- One transaction: `refreshToken.deleteMany` + `user.delete`; `refresh_tokens.user_id` also has `ON DELETE CASCADE` as schema-level backstop.
- After commit: refresh → `ACCOUNT_NOT_FOUND`; access-token middleware re-resolves the user per request, so deleted accounts fail immediately (no token blacklist needed).
- A refresh racing the deletion either commits first (its successor is then deleted with the user) or fails the claim / successor FK and persists nothing.

## Password reset

- `forgot-password`: invalidates prior outstanding reset tokens and stores only the SHA-256 hash of the new one; the raw token goes only to the email service. Response never reveals account existence.
- `reset-password`: single-use claim via `updateMany WHERE id = ? AND used_at IS NULL` with `count === 1` check — one winner under concurrency (`PASSWORD_RESET_TOKEN_USED` for the loser) — then password update and `refreshToken.deleteMany` in the same transaction.

## Social login linking

- `social_accounts` has a unique `(provider, provider_subject)` key.
- First-login creation re-checks the link inside the transaction; a concurrent duplicate insert surfaces as P2002 AFTER the winner commits (unique-index insertion waits on the in-flight row), and the loser recovers by re-reading the committed link and issuing a session for the same account. Net effect: one user, one link, both requests succeed.
- Non-ACTIVE accounts are rejected before any session issuance, in every path.

## Signup

- Duplicate email under concurrency resolves to one created account and a stable `409 EMAIL_ALREADY_IN_USE` for the loser (P2002 mapped in the service).

## What is intentionally NOT server-side

Single-flight refresh scheduling, dropping late refresh results after a newer local session is adopted, and local cancellation are client responsibilities (see `AUTH_CROSS_PLATFORM_CONTRACT.md`). The server only guarantees that any interleaving of client requests preserves the invariants above.
