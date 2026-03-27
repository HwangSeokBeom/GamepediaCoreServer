# GamePedia Auth Server

Standalone authentication backend for the GamePedia iOS app. This project is intentionally separate from the translation server and focuses only on email/password authentication and user account session management.

## 1. Recommended project folder structure

```text
GamePediaAuthServer/
├── .env.example
├── .gitignore
├── README.md
├── package.json
├── sql/
│   └── init_auth_schema.sql
├── prisma/
│   └── schema.prisma
└── src/
    ├── app.js
    ├── server.js
    ├── config/
    │   ├── env.js
    │   └── prisma.js
    ├── controllers/
    │   └── auth.controller.js
    ├── middlewares/
    │   ├── auth.middleware.js
    │   ├── error.middleware.js
    │   └── validate.middleware.js
    ├── routes/
    │   └── auth.routes.js
    ├── services/
    │   ├── auth.service.js
    │   ├── password.service.js
    │   └── token.service.js
    ├── utils/
    │   ├── api-response.js
    │   ├── async-handler.js
    │   └── error-response.js
    └── validators/
        └── auth.validator.js
```

### Why this structure works

- `app.js`: Express wiring only.
- `server.js`: process startup and graceful shutdown.
- `routes/`: endpoint registration, no business logic.
- `controllers/`: request-to-service mapping and HTTP status handling.
- `services/`: authentication logic, password hashing, token issuing.
- `middlewares/`: auth guard, validation, and error handling.
- `config/`: runtime environment and Prisma client setup.
- `prisma/`: database schema and future migrations.
- `sql/`: concrete PostgreSQL DDL for an initial migration or manual DB bootstrap.

## 2. Database design

### `users`

- `id`: UUID primary key. Stable identifier to expose to the client.
- `email`: unique login identifier. Stored normalized in lowercase.
- `password_hash`: bcrypt-hashed password. Never store raw passwords.
- `nickname`: display name used by the app UI.
- `profile_image_url`: nullable avatar URL for future profile support.
- `status`: account lifecycle flag such as `ACTIVE`, `INACTIVE`, `SUSPENDED`.
- `created_at`: audit field for account creation time.
- `updated_at`: audit field for profile/account updates.

### `refresh_tokens`

- `id`: UUID primary key for the token row.
- `user_id`: foreign key to `users.id`.
- `token_hash`: SHA-256 hash of the raw refresh token. Stored hashed so a DB leak does not expose reusable session tokens.
- `device_name`: optional client-supplied label such as `iPhone 16 Pro`.
- `expires_at`: hard expiration time for the refresh token.
- `revoked_at`: nullable timestamp used for logout and rotation revocation.
- `created_at`: session creation time.

### Practical notes

- One user can hold multiple active refresh tokens to support multiple devices.
- `refresh_tokens.user_id`, `expires_at`, and `revoked_at` are indexed for practical lookup and cleanup.
- Access tokens are not stored in the DB because they are short-lived JWTs.

## 3. Prisma schema

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UserStatus {
  ACTIVE
  INACTIVE
  SUSPENDED
}

model User {
  id              String         @id @default(uuid()) @db.Uuid
  email           String         @unique @db.VarChar(320)
  passwordHash    String         @map("password_hash") @db.VarChar(255)
  nickname        String         @db.VarChar(50)
  profileImageUrl String?        @map("profile_image_url") @db.Text
  status          UserStatus     @default(ACTIVE)
  createdAt       DateTime       @default(now()) @map("created_at")
  updatedAt       DateTime       @updatedAt @map("updated_at")
  refreshTokens   RefreshToken[]

  @@map("users")
}

model RefreshToken {
  id         String    @id @default(uuid()) @db.Uuid
  userId     String    @map("user_id") @db.Uuid
  tokenHash  String    @unique @map("token_hash") @db.Char(64)
  deviceName String?   @map("device_name") @db.VarChar(100)
  expiresAt  DateTime  @map("expires_at")
  revokedAt  DateTime? @map("revoked_at")
  createdAt  DateTime  @default(now()) @map("created_at")
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([expiresAt])
  @@index([revokedAt])
  @@map("refresh_tokens")
}
```

## 4. API specification

Response format:

```json
{
  "success": true,
  "data": {}
}
```

```json
{
  "success": false,
  "error": {
    "code": "SOME_ERROR_CODE",
    "message": "Readable message"
  }
}
```

### `POST /auth/signup`

- Purpose: create a new email/password account and immediately issue tokens.
- Request body:

```json
{
  "email": "player@example.com",
  "password": "Passw0rd!",
  "nickname": "PlayerOne",
  "profileImageUrl": "https://cdn.example.com/avatar.png",
  "deviceName": "iPhone 16 Pro"
}
```

- Success `201`:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "0d2d6ba2-06dd-46a7-ab0f-3df0d6cb2054",
      "email": "player@example.com",
      "nickname": "PlayerOne",
      "profileImageUrl": "https://cdn.example.com/avatar.png",
      "status": "ACTIVE",
      "createdAt": "2026-03-25T12:00:00.000Z",
      "updatedAt": "2026-03-25T12:00:00.000Z"
    },
    "tokens": {
      "accessToken": "access-token",
      "refreshToken": "refresh-token"
    }
  }
}
```

- Common failures:
  - `400` `VALIDATION_ERROR`
  - `409` `EMAIL_ALREADY_IN_USE`

### `POST /auth/login`

- Purpose: verify credentials and create a new session.
- Request body:

```json
{
  "email": "player@example.com",
  "password": "Passw0rd!",
  "deviceName": "iPhone 16 Pro"
}
```

- Success `200`: same shape as signup.
- Common failures:
  - `400` `VALIDATION_ERROR`
  - `401` `INVALID_CREDENTIALS`
  - `403` `USER_NOT_ACTIVE`

### `POST /auth/refresh`

- Purpose: rotate the refresh token and issue a new access token.
- Request body:

```json
{
  "refreshToken": "refresh-token",
  "deviceName": "iPhone 16 Pro"
}
```

- Success `200`:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "0d2d6ba2-06dd-46a7-ab0f-3df0d6cb2054",
      "email": "player@example.com",
      "nickname": "PlayerOne",
      "profileImageUrl": "https://cdn.example.com/avatar.png",
      "status": "ACTIVE",
      "createdAt": "2026-03-25T12:00:00.000Z",
      "updatedAt": "2026-03-25T12:00:00.000Z"
    },
    "tokens": {
      "accessToken": "new-access-token",
      "refreshToken": "new-refresh-token"
    }
  }
}
```

- Common failures:
  - `400` `VALIDATION_ERROR`
  - `401` `INVALID_REFRESH_TOKEN`
  - `401` `REFRESH_TOKEN_REVOKED`
  - `403` `USER_NOT_ACTIVE`

### `POST /auth/logout`

- Purpose: revoke the current refresh token session.
- Request body:

```json
{
  "refreshToken": "refresh-token"
}
```

- Success `200`:

```json
{
  "success": true,
  "data": {
    "loggedOut": true
  }
}
```

- Common failures:
  - `400` `VALIDATION_ERROR`

### `GET /auth/me`

- Purpose: fetch the current authenticated user profile.
- Request header:

```http
Authorization: Bearer <access-token>
```

- Success `200`:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "0d2d6ba2-06dd-46a7-ab0f-3df0d6cb2054",
      "email": "player@example.com",
      "nickname": "PlayerOne",
      "profileImageUrl": "https://cdn.example.com/avatar.png",
      "status": "ACTIVE",
      "createdAt": "2026-03-25T12:00:00.000Z",
      "updatedAt": "2026-03-25T12:00:00.000Z"
    }
  }
}
```

- Common failures:
  - `401` `AUTHORIZATION_REQUIRED`
  - `401` `INVALID_ACCESS_TOKEN`
  - `401` `USER_NOT_FOUND`
  - `403` `USER_NOT_ACTIVE`

## 5. Security design

- Password hashing: bcrypt with `BCRYPT_SALT_ROUNDS=12`.
- Access token: signed JWT, short-lived, default `15m`.
- Refresh token: signed JWT, long-lived, default `30d`.
- Refresh token storage: only the SHA-256 hash is saved in `refresh_tokens.token_hash`.
- Refresh rotation: `POST /auth/refresh` revokes the current refresh token row and inserts a new one.
- Logout revocation: `POST /auth/logout` marks the token row with `revoked_at`.

### Why store refresh tokens hashed

- If the database leaks, attackers still do not get usable raw refresh tokens.
- It mirrors password handling principles for a credential-like secret.
- Revocation still works by hashing the presented token and matching the stored hash.

### Expiration strategy

- Access token: 15 minutes.
- Refresh token: 30 days.
- Reasoning: frequent access token expiry limits damage if leaked, while refresh tokens keep the iOS UX smooth.

## 6. Express implementation skeleton

The project already includes practical starter code:

- `src/app.js`: Express app and route mounting.
- `src/server.js`: server startup and graceful shutdown.
- `src/controllers/auth.controller.js`: HTTP handlers.
- `src/services/auth.service.js`: signup/login/refresh/logout/me logic.
- `src/services/token.service.js`: JWT creation and token hashing.
- `src/services/password.service.js`: bcrypt helpers.
- `src/middlewares/auth.middleware.js`: bearer token authentication.
- `src/middlewares/error.middleware.js`: consistent error responses.

## 7. Environment variables

- Use `.env.development` for local development and `.env.production` for EC2 production.
- Select the environment with `NODE_ENV`:
  - `development` loads `.env.development`
  - `production` loads `.env.production`
- Optional legacy fallback files are still supported:
  - `.env`
  - `.env.local`
  - `.env.development.local`
  - `.env.production.local`
- `NODE_ENV`
- `HOST`
- `PORT`
- `DATABASE_URL`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `ACCESS_TOKEN_EXPIRES_IN`
- `REFRESH_TOKEN_EXPIRES_IN`
- `BCRYPT_SALT_ROUNDS`
- `APP_WEB_BASE_URL`
- `PASSWORD_RESET_TOKEN_TTL_MINUTES`
- `MAIL_MODE`
- `MAIL_HOST`
- `MAIL_PORT`
- `MAIL_SECURE`
- `MAIL_USER`
- `MAIL_PASSWORD`
- `MAIL_FROM`
- `APPLE_CLIENT_ID`
- `GOOGLE_CLIENT_ID`
- Optional placeholders in `.env.example`:
  - `REDIS_URL`
  - `TWITCH_CLIENT_ID`
  - `TWITCH_CLIENT_SECRET`
  - `PAPAGO_CLIENT_ID`
  - `PAPAGO_CLIENT_SECRET`
  - `TRANSLATION_BASE_URL`

## 8. Implementation order

1. Create the standalone project and install dependencies.
2. Configure `.env` and PostgreSQL connection.
3. Write `prisma/schema.prisma`.
4. Run Prisma migration and generate the client.
5. Implement validation, error handling, and shared config.
6. Implement password and token services.
7. Implement auth service and controller flow.
8. Register routes and bearer auth middleware.
9. Test signup, login, refresh, logout, and me end-to-end.
10. Integrate the iOS client with the final API contract.

## 9. iOS integration notes

- Store:
  - `accessToken`
  - `refreshToken`
  - `user.id`
  - `user.email`
  - `user.nickname`
  - `user.profileImageUrl`
- Send the access token in the `Authorization` header as `Bearer <accessToken>`.
- On app launch:
  1. Check if a refresh token exists in secure storage.
  2. If it exists, call `POST /auth/refresh`.
  3. Save the rotated `accessToken` and `refreshToken`.
  4. Use `GET /auth/me` if you need to rebuild current user state.
  5. If refresh fails with `401`, clear stored credentials and show the login screen.
- Use Keychain for token storage, not `UserDefaults`.
- The client should treat refresh as a silent recovery path when an API call returns `401` because the access token expired.

## 10. PostgreSQL SQL schema

### CREATE TABLE statements

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_status') THEN
    CREATE TYPE user_status AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(320) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  nickname VARCHAR(50) NOT NULL,
  profile_image_url TEXT NULL,
  status user_status NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  device_name VARCHAR(100) NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT refresh_tokens_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE
);
```

### CREATE INDEX statements

```sql
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_revoked_at ON refresh_tokens(revoked_at);
```

### Why these tables and indexes exist

- `users`: supports signup by creating an account row, login by looking up a normalized email, and `GET /auth/me` by returning profile data from the authenticated user id.
- `refresh_tokens`: supports refresh by matching the presented refresh token hash, logout by setting `revoked_at`, and multi-device sessions by allowing more than one token row per user.
- `users.email`: login lookups are already covered by the unique constraint, which creates a backing index in PostgreSQL.
- `refresh_tokens.user_id`: accelerates cleanup, session management, and future "log out all devices" features.
- `refresh_tokens.expires_at`: helps background cleanup of expired sessions.
- `refresh_tokens.token_hash`: exact-match refresh/logout lookups are already covered by the unique constraint, which creates a backing index.
- `refresh_tokens.revoked_at`: helps efficiently filter active versus revoked sessions.

### Setup note

- `pgcrypto` is enabled so PostgreSQL can generate UUID values using `gen_random_uuid()`.
- This SQL is ready to use as an initial migration if you want a manual SQL-first bootstrap before Prisma migrations.

## Startup

```bash
npm install
cp .env.example .env.local
npx prisma migrate dev --name init
npx prisma generate
npm run dev
```
