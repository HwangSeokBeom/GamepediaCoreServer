# Pre-production dependency security review

## Scope

This change updates production dependencies without using `npm audit fix`.
The selected versions preserve the repository's Node.js 20 runtime contract.

- `multer` 2.2 resolves the reported upload denial-of-service advisories.
- `nodemailer` 9.0.3 resolves the reported SMTP/header/file-access advisories.
- `firebase-admin` 13.10 applies the latest Node.js 20-compatible 13.x fixes.
- Patched transitive versions are pinned for Express request parsing, Prisma
  configuration, and Firebase Realtime Database WebSocket handling.

`@prisma/client` and `prisma` remain on 6.19.2 because Prisma 7 is a major
migration. The vulnerable `effect` package used by Prisma's configuration CLI
is overridden with a patched compatible implementation and is verified through
client generation plus the disposable migration and PostgreSQL gates.

## Residual audit entries

`npm audit --omit=dev` still reports moderate entries through optional
Firestore and Cloud Storage dependency trees bundled by `firebase-admin`.
GamePediaCoreServer initializes Firebase Admin only for Cloud Messaging; it
does not import or initialize Firestore, Cloud Storage, or Realtime Database.

Removing those residual entries requires `firebase-admin` 14, which requires
Node.js 22. The repository's CI and deployment contract currently use Node.js
20, so that major upgrade is deliberately deferred instead of silently
changing the production runtime. A Node.js 22 migration must validate the
runner, PM2 host, Firebase Messaging initialization, and rollback path together.

This reachability assessment does not claim the installed optional code is
vulnerability-free. It records why the remaining moderate entries are not
request-runtime paths in the current application and why a major runtime change
is outside this narrowly scoped dependency update.

## Verification contract

Before release, this branch must pass:

- clean `npm ci` on Node.js 20 and the local supported Node.js runtime;
- `npm audit --omit=dev` with no critical or high advisory;
- Prisma validate, generate, and all repository migrations;
- the self-isolating PostgreSQL 16 gate;
- Firebase Admin initialization and push-service tests;
- mail transport and upload/request contract tests;
- the canonical test suite;
- startup/bootstrap smoke tests;
- source secret and conflict-marker scans.
