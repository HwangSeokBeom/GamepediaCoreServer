# SMTP Startup Readiness Policy

A production-like server (any `NODE_ENV` other than `development`/`test`, e.g.
`production` and `staging`) must not report itself ready for password-reset
service while its configured SMTP transport is unusable. The forgot-password
endpoint intentionally returns an account-enumeration-safe generic response, so
a broken mail transport would otherwise fail silently.

## Behavior

At startup, after the database and Redis checks and **before** the HTTP port is
bound, the server runs a bounded SMTP verification
(`verifyMailStartupReadiness` in `src/services/email.service.js`):

1. The Nodemailer transporter is created centrally (one cached instance).
2. `transporter.verify()` (connect + EHLO + authenticate) is raced against a
   finite timeout (`SMTP_VERIFY_TIMEOUT_MS`, default 10000 ms, validated range
   1000–60000 ms). The timeout timer is always settled/cleared.
3. On success, the same transporter is reused for later mail delivery, and
   `GET /health` reports `mail: { mode: "smtp", verified: true }`.
4. On failure, one sanitized log line is emitted
   (`[email] event=smtp_verify_failed reason=<code>`), the transporter is
   closed, startup aborts before `listen()`, and the process exits non-zero.

Verification runs exactly once per process. It is triggered only by the server
bootstrap (`startServer` in `src/server.js`) — never by module import side
effects — so importing the app or services in tests does not contact SMTP.

## Stable reason codes

Raw transport errors can embed the host, user, server banner, or recipient, so
they are never logged or rethrown. Every failure collapses to one of:

| Reason code | Meaning |
| --- | --- |
| `smtp_dns_failure` | Host name resolution failed (`EDNS`, `ENOTFOUND`, …) |
| `smtp_connection_failure` | TCP/socket connection failed (`ECONNECTION`, `ECONNREFUSED`, `ESOCKET`, …) |
| `smtp_auth_failure` | Authentication rejected (`EAUTH`) |
| `smtp_tls_failure` | TLS/STARTTLS or certificate failure (`ETLS`, cert codes) |
| `smtp_timeout` | Verification exceeded `SMTP_VERIFY_TIMEOUT_MS` or the transport timed out (`ETIMEDOUT`) |
| `smtp_configuration_failure` | Transporter could not be created from configuration |
| `smtp_transport_failure` | Any other transport error |

Logs never contain the SMTP host, user, password, recipient, reset URL, token,
or raw Nodemailer error text.

## Environment settings

| Variable | Default | Notes |
| --- | --- | --- |
| `SMTP_VERIFY_ON_STARTUP` | `true` in production-like, `false` in development/test | Setting `false` in production-like environments fails configuration validation — the policy cannot be downgraded to a warning. |
| `SMTP_VERIFY_TIMEOUT_MS` | `10000` | Must be within 1000–60000. |

Omitted or invalid SMTP configuration (`MAIL_HOST`, `MAIL_USER`,
`MAIL_PASSWORD`, `MAIL_FROM`, `MAIL_MODE`) still fails earlier, during
configuration validation in `src/config/env.js`, before any network activity.

## Development and test

- `MAIL_MODE=log` (the development/test default) never contacts SMTP; messages
  are handed to the optional test sink only.
- With `MAIL_MODE=smtp` in development/test, startup verification is skipped
  unless `SMTP_VERIFY_ON_STARTUP=true` is set explicitly, so unit tests and
  local runs never open network connections by accident.
- Tests inject fake transporters via `setTransporterForTesting` /
  `verifySmtpTransport({ transporter })` and reset state with
  `resetMailStateForTesting` (both restricted to development/test).

## Operational impact

This policy intentionally couples deployment readiness to SMTP availability:

- **A temporary SMTP outage blocks new deployments and restarts** of
  production/staging instances. Already-running instances are unaffected.
- There is no automatic fallback to log mode outside development/test.
- If SMTP is down during an incident, restore the mail transport (or point the
  configuration at a working relay) before restarting the server. Do not work
  around the check by weakening it; it exists so password-reset service is
  never silently unavailable.
