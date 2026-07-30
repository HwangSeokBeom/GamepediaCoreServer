# Pre-production dependency security review

## Runtime contract

The supported runtime is Node.js 22 or newer. This is enforced in three places:

- `package.json` declares `engines.node >=22.0.0`;
- `.npmrc` enables `engine-strict=true`;
- the validation workflow installs Node.js 22.

The self-hosted deploy runner must therefore expose Node.js 22 to the deployment
shell before this change is released. `npm ci` fails closed on an older runtime.

## Deployed dependency tree

Production installation uses the committed lockfile and the explicit
`npm ci --omit=dev --omit=optional` command. `.npmrc` also sets
`omit=optional`, so a plain clean install used by validation cannot silently
restore unused Firebase service trees. The server imports Firebase Admin only
for Cloud Messaging; it does not import Firestore, Cloud Storage or Realtime
Database. The deployed installation therefore contains neither development
tooling nor those unused optional service trees.

`firebase-admin` is pinned to 14.2.0. `@prisma/client` and `prisma` remain on
6.19.2 because Prisma 7 is a separate major migration. Existing compatible
transitive overrides remain pinned and are exercised by Prisma generation,
migrations, PostgreSQL gates, HTTP tests and startup tests.

The release gate first verifies this package/workflow/deploy contract and then
audits it:

```bash
npm run test:dependency-security
```

It executes:

```bash
npm audit --omit=dev --omit=optional --audit-level=moderate
```

and must report zero deployed-tree vulnerabilities. Development-only tooling is
not represented as deployed code; its behavior is verified by the pinned
OpenAPI lint and generated-client gates.

## Service boundary

Cloud Messaging initialization and push-service tests must pass after a clean
`npm ci`. If the application later starts using Firestore, Cloud Storage,
Realtime Database, or another Firebase service whose packages are currently
optional, that feature must first remove or narrow `omit=optional`, review the
new deployed tree, and rerun the security and full regression gates. It must not
assume those omitted modules are present.

## Verification contract

Before release, this branch must pass:

- clean `npm ci` on Node.js 22;
- `npm run test:dependency-security` with zero vulnerabilities;
- Prisma validate, generate, and every repository migration;
- the self-isolating PostgreSQL 16 gates;
- Firebase Admin initialization and push-service tests;
- mail transport and upload/request contract tests;
- the canonical test suite and startup/bootstrap tests;
- pinned OpenAPI lint and generated iOS client compilation;
- source secret and conflict-marker scans.
