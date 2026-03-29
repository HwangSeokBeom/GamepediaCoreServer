# GamePedia Core Server

GamePedia iOS 앱을 위한 핵심 백엔드 서버입니다.  
이 서버는 게임 정보 조회, 리뷰, 찜(즐겨찾기), 사용자 인증(Auth), 라이브러리, 검색 기록 저장, 신고/차단 등의 기능을 제공합니다.

중요한 전제는 다음과 같습니다.

- 이 프로젝트는 별도의 Auth Server가 있는 구조가 아닙니다.
- 인증 기능은 Core Server 내부 모듈과 서비스로 함께 포함되어 있습니다.
- Translate Server는 별도 저장소에서 운영되며, Core Server는 필요 시 번역 프록시/번역 서버를 호출합니다.
- 이 README는 현재 저장소의 실제 코드 구조를 기준으로 작성되었습니다.

## 1. 프로젝트 개요

GamePedia Core Server는 Express 기반의 Node.js API 서버입니다.  
PostgreSQL + Prisma ORM을 사용해 사용자, 세션, 리뷰, 찜, 신고, 검색 기록, 라이브러리 상태 데이터를 관리하고, JWT 기반 인증과 외부 게임 데이터/소셜 로그인 연동을 제공합니다.

현재 서버가 담당하는 주요 영역:

- 이메일/비밀번호 회원가입 및 로그인
- Apple / Google 소셜 로그인
- JWT Access Token / Refresh Token 발급 및 갱신
- IGDB 기반 게임 목록/상세/검색/추천 조회
- 게임 리뷰 작성 및 조회
- 찜(즐겨찾기) 추가/삭제/조회
- 내 라이브러리 집계 조회
- Steam 계정 연동 및 최근 플레이 게임 조회
- 플레이 중 / 완료 / 중단 상태 관리
- 검색 기록 저장
- 신고 / 유저 차단
- 프로필 조회 및 프로필 이미지 관리

### 기술 스택

- Node.js
- Express
- Prisma ORM
- PostgreSQL
- JWT Authentication
- Redis
  - 선택 구성, 현재 코드는 연결 점검 중심
- PM2
- AWS EC2 배포

## 2. 전체 시스템 구조

```mermaid
flowchart LR
    A["GamePedia iOS App"] --> B["GamePedia Core Server"]
    B --> C["PostgreSQL"]
    B --> D["IGDB / Twitch API"]
    B --> E["Steam Web API"]
    B --> F["Apple / Google Identity"]
    B --> G["Translate Server (별도 저장소)"]
    B -. 선택적 연결 확인 .-> H["Redis"]
```

역할 분리는 다음과 같습니다.

- `iOS App`
  - 사용자 인터페이스 제공
  - 로그인 이후 Access Token을 `Authorization: Bearer <token>` 형태로 전송
  - Steam 연동 시 Core Server가 내려주는 링크를 열고 결과를 다시 앱 플로우로 연결
- `GamePedia Core Server`
  - 비즈니스 로직의 중심
  - 인증, 세션, 라이브러리, 리뷰, 찜, 검색, 신고, 유저 프로필 처리
  - 외부 API 호출과 DB 저장 담당
- `Translate Server`
  - 별도 저장소에서 관리
  - 검색어 번역/검색 결과 번역 시 Core Server가 HTTP로 호출
- `PostgreSQL`
  - 영속 데이터 저장소
- `Redis`
  - 현재 코드 기준으로는 필수 인프라가 아니며, 서버 시작 시 연결 가능 여부를 점검하는 선택 구성

## 3. 주요 기능

### 3.1 사용자 인증

- 이메일/비밀번호 회원가입
- 이메일/비밀번호 로그인
- Apple 로그인
- Google 로그인
- Refresh Token Rotation
- 로그아웃 시 세션 폐기
- 비밀번호 재설정 토큰 발급 및 사용

인증 관련 엔드포인트는 [`src/routes/auth.routes.js`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/src/routes/auth.routes.js)에 정의되어 있습니다.

### 3.2 게임 정보 조회

- 하이라이트 게임 조회
- 인기 게임 조회
- 추천 게임 조회
- 게임 검색
- 게임 자동완성 제안
- 게임 상세 조회

게임 정보는 현재 [`src/modules/igdb/`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/src/modules/igdb) 모듈이 담당합니다.  
즉, 개념적으로는 `game` 도메인이지만 실제 구현은 IGDB 연동 중심으로 분리되어 있습니다.

### 3.3 리뷰 작성 및 조회

- 리뷰 작성
- 특정 게임의 리뷰 목록 조회
- 내 리뷰 목록 조회
- 리뷰 수정 / 삭제

리뷰 데이터는 `reviews` 테이블에 저장되며, 사용자 본인 소유 검증을 통해 수정/삭제 권한을 통제합니다.

### 3.4 찜(즐겨찾기)

- 게임 찜 추가
- 게임 찜 삭제
- 내 찜 목록 조회
- 특정 게임의 찜 여부 확인

찜 기능은 `favorite_games` 테이블을 기반으로 동작하며, 라이브러리 응답에서도 그대로 재사용됩니다.

### 3.5 플레이 중 게임 관리

라이브러리 기능은 다음 데이터를 함께 묶어서 제공합니다.

- 최근 플레이한 게임
  - Steam 연동 계정 기준
- 플레이 중
  - 사용자가 직접 관리하는 상태
- 찜한 게임
  - 기존 `favorite_games`
- 리뷰 작성함
  - 기존 `reviews`

또한 다음 기능을 포함합니다.

- 내 라이브러리 집계 조회
- Steam 계정 연동 / 해제
- 플레이 중 / 완료 / 중단 상태 저장

### 3.6 검색 기록 저장

검색어 자체는 [`src/modules/igdb/igdb.service.js`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/src/modules/igdb/igdb.service.js) 내부에서 처리되고,  
정규화된 검색어와 결과 수는 `search_queries` 테이블에 기록됩니다.

### 3.7 신고 및 차단

- 리뷰/댓글/유저 신고
- 특정 유저 차단 / 차단 해제
- 차단 유저의 리뷰를 목록에서 숨기는 moderation hook 포함

## 4. 실제 프로젝트 구조

아래는 현재 저장소 기준의 실제 구조입니다.

```text
GamePediaCoreServer/
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── src/
│   ├── app.js
│   ├── server.js
│   ├── config/
│   │   ├── env.js
│   │   ├── load-env.js
│   │   ├── prisma.js
│   │   └── redis.js
│   ├── controllers/
│   │   └── auth.controller.js
│   ├── middlewares/
│   │   ├── auth.middleware.js
│   │   ├── error.middleware.js
│   │   └── validate.middleware.js
│   ├── modules/
│   │   ├── favorite/
│   │   ├── igdb/
│   │   ├── library/
│   │   ├── moderation/
│   │   ├── review/
│   │   ├── translation/
│   │   └── user/
│   ├── routes/
│   │   └── auth.routes.js
│   ├── services/
│   │   ├── apple-auth.service.js
│   │   ├── auth.service.js
│   │   ├── email.service.js
│   │   ├── google-auth.service.js
│   │   ├── password-reset-email.service.js
│   │   ├── password.service.js
│   │   ├── search-query-translation.service.js
│   │   ├── search-result-translation.service.js
│   │   ├── steam.service.js
│   │   └── token.service.js
│   ├── utils/
│   │   ├── api-response.js
│   │   ├── async-handler.js
│   │   ├── auth-error.js
│   │   ├── error-response.js
│   │   └── logger.js
│   └── validators/
│       └── auth.validator.js
├── ecosystem.config.js
├── deploy.sh
├── prisma.config.js
└── .env.production
```

주의할 점:

- 인증은 `src/routes`, `src/controllers`, `src/services`, `src/validators`에 분산된 전통적 계층 구조입니다.
- 나머지 도메인은 `src/modules/*` 형태로 분리되어 있습니다.
- 즉, 이 프로젝트는 인증만 따로 서버로 분리된 구조가 아니라, Core Server 안에 Auth 기능이 내장된 혼합 구조입니다.

## 5. 아키텍처 설명

### 5.1 Controller

Controller는 HTTP 요청과 서비스 호출 사이의 얇은 계층입니다.

- 요청에서 필요한 값을 꺼냄
- 인증 정보(`req.auth`) 전달
- 서비스 반환값을 `successResponse()`로 감싸 응답
- HTTP 상태 코드 결정

예:

- `src/controllers/auth.controller.js`
- `src/modules/review/review.controller.js`
- `src/modules/library/library.controller.js`

### 5.2 Service

Service는 핵심 비즈니스 로직을 담당합니다.

- Prisma를 통한 DB 조회/저장
- 외부 API 호출
- 권한 검증
- 상태 전이 처리
- DTO 매핑 전 데이터 조립

예:

- `src/services/auth.service.js`
- `src/modules/igdb/igdb.service.js`
- `src/modules/review/review.service.js`
- `src/modules/library/library.service.js`
- `src/services/steam.service.js`

현재 코드베이스는 별도의 repository 레이어를 두지 않고, 서비스에서 Prisma를 직접 호출하는 방식입니다.

### 5.3 Prisma

Prisma는 PostgreSQL 스키마와 애플리케이션 모델 사이를 연결합니다.

대표 모델:

- `User`
- `RefreshToken`
- `PasswordResetToken`
- `SocialAccount`
- `Review`
- `FavoriteGame`
- `UserGameLibrary`
- `Report`
- `UserBlock`
- `SearchQuery`

스키마는 [`prisma/schema.prisma`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/prisma/schema.prisma)에서 관리하며, 실제 배포 시에는 `prisma migrate deploy`를 사용합니다.

### 5.4 Middleware

공통 처리 로직은 미들웨어로 분리되어 있습니다.

- `auth.middleware.js`
  - JWT Access Token 검증
  - 사용자 상태 확인
  - `req.auth` 설정
- `validate.middleware.js`
  - Zod 기반 입력 검증
- `error.middleware.js`
  - `AppError` 및 Prisma/업로드 에러 공통 응답 처리

### 5.5 JWT 인증 흐름

1. 사용자가 `/auth/signup`, `/auth/login`, `/auth/apple`, `/auth/google` 중 하나로 로그인합니다.
2. 서버는 Access Token + Refresh Token을 발급합니다.
3. Access Token은 클라이언트가 API 호출 시 Bearer 토큰으로 전송합니다.
4. 인증이 필요한 API는 `authenticateAccessToken` 미들웨어를 통과해야 합니다.
5. Refresh Token은 DB에 해시 형태로 저장됩니다.
6. `/auth/refresh` 호출 시 기존 Refresh Token을 폐기하고 새 토큰 쌍을 발급합니다.
7. `/auth/logout` 시 해당 Refresh Token 세션을 종료합니다.

## 6. 환경 변수 설명

환경 변수는 [`src/config/load-env.js`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/src/config/load-env.js)에 따라 다음 순서로 로드됩니다.

1. `.env`
2. `.env.local`
3. `.env.${NODE_ENV}`
4. `.env.${NODE_ENV}.local`

배포 스크립트 [`deploy.sh`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/deploy.sh)는 `.env.production`을 직접 로드합니다.

### 6.1 핵심 서버/DB

| 변수 | 설명 | 필수 |
| --- | --- | --- |
| `NODE_ENV` | 실행 환경 (`development`, `production`, `staging`, `test`) | 예 |
| `HOST` | 서버 바인딩 호스트 | 아니오 |
| `PORT` | 서버 포트 | 예 |
| `DATABASE_URL` | PostgreSQL 연결 문자열 | 예 |

### 6.2 JWT / 인증

| 변수 | 설명 | 필수 |
| --- | --- | --- |
| `JWT_ACCESS_SECRET` | Access Token 서명 키 | 예 |
| `JWT_REFRESH_SECRET` | Refresh Token 서명 키 | 예 |
| `ACCESS_TOKEN_EXPIRES_IN` | Access Token 만료 시간 | 예 |
| `REFRESH_TOKEN_EXPIRES_IN` | Refresh Token 만료 시간 | 예 |
| `BCRYPT_SALT_ROUNDS` | bcrypt salt rounds | 예 |
| `PASSWORD_RESET_TOKEN_TTL_MINUTES` | 비밀번호 재설정 토큰 TTL(분) | 예 |

### 6.3 앱/공개 URL

| 변수 | 설명 | 필수 |
| --- | --- | --- |
| `APP_WEB_BASE_URL` | 앱/웹 기준 베이스 URL | 운영 필수 |
| `API_PUBLIC_BASE_URL` | 외부에서 접근 가능한 Core Server URL. Steam callback URL 생성에 사용 | Steam 사용 시 권장 |

### 6.4 메일

| 변수 | 설명 | 필수 |
| --- | --- | --- |
| `MAIL_MODE` | `log` 또는 `smtp` | 예 |
| `MAIL_HOST` | SMTP 호스트 | `MAIL_MODE=smtp`일 때 |
| `MAIL_PORT` | SMTP 포트 | `smtp`일 때 |
| `MAIL_SECURE` | TLS 사용 여부 | `smtp`일 때 |
| `MAIL_USER` | SMTP 계정 | `smtp`일 때 |
| `MAIL_PASSWORD` | SMTP 비밀번호 | `smtp`일 때 |
| `MAIL_FROM` | 발신 주소 | `smtp`일 때 |
| `EMAIL_FROM_ADDRESS` | `MAIL_FROM` 대체용 호환 변수 | 아니오 |

### 6.5 소셜 로그인 / 외부 API

| 변수 | 설명 | 필수 |
| --- | --- | --- |
| `APPLE_CLIENT_ID` | Apple 로그인 검증용 Client ID | Apple 로그인 사용 시 |
| `GOOGLE_CLIENT_ID` | Google 로그인 검증용 Client ID | Google 로그인 사용 시 |
| `STEAM_API_KEY` | Steam Web API Key | Steam 라이브러리 사용 시 |
| `TWITCH_CLIENT_ID` | IGDB 접근용 Twitch Client ID | 게임 API 사용 시 |
| `TWITCH_CLIENT_SECRET` | IGDB 접근용 Twitch Client Secret | 게임 API 사용 시 |

### 6.6 번역 서버 연동

| 변수 | 설명 | 필수 |
| --- | --- | --- |
| `LIBRETRANSLATE_URL` | 검색어 번역 프록시/번역 서버 URL | 번역 사용 시 |
| `LIBRETRANSLATE_TIMEOUT_MS` | 검색어 번역 타임아웃 | 아니오 |
| `PAPAGO_CLIENT_ID` | Papago 연동 ID | 선택 |
| `PAPAGO_CLIENT_SECRET` | Papago 연동 Secret | 선택 |
| `PAPAGO_ENDPOINT` | Papago API Endpoint | 아니오 |
| `PAPAGO_TIMEOUT_MS` | Papago 타임아웃 | 아니오 |
| `TRANSLATION_BASE_URL` | 결과 번역 프록시 URL | 선택 |
| `TRANSLATION_PROXY_BASE_URL` | `TRANSLATION_BASE_URL` 대체 호환 변수 | 선택 |

### 6.7 기타

| 변수 | 설명 | 필수 |
| --- | --- | --- |
| `REDIS_URL` | Redis 연결 문자열. 현재는 부팅 시 연결 점검 용도 | 선택 |
| `PROFILE_IMAGE_MAX_SIZE_BYTES` | 업로드 가능한 프로필 이미지 최대 크기 | 예 |

### 6.8 `.env.production` 예시

```env
NODE_ENV=production
HOST=0.0.0.0
PORT=3001

DATABASE_URL=postgresql://user:password@db-host:5432/gamepedia

JWT_ACCESS_SECRET=change-me
JWT_REFRESH_SECRET=change-me-too
ACCESS_TOKEN_EXPIRES_IN=15m
REFRESH_TOKEN_EXPIRES_IN=30d
BCRYPT_SALT_ROUNDS=12
PASSWORD_RESET_TOKEN_TTL_MINUTES=60

APP_WEB_BASE_URL=https://app.example.com
API_PUBLIC_BASE_URL=https://api.example.com

MAIL_MODE=log
MAIL_PORT=587
MAIL_SECURE=false

APPLE_CLIENT_ID=com.example.gamepedia
GOOGLE_CLIENT_ID=google-client-id.apps.googleusercontent.com
STEAM_API_KEY=steam-api-key
TWITCH_CLIENT_ID=twitch-client-id
TWITCH_CLIENT_SECRET=twitch-client-secret

LIBRETRANSLATE_URL=https://translate.example.com
TRANSLATION_PROXY_BASE_URL=https://translate.example.com

REDIS_URL=redis://127.0.0.1:6379/0
PROFILE_IMAGE_MAX_SIZE_BYTES=5242880
```

## 7. 설치 및 실행

### 7.1 로컬 개발

```bash
npm install
npx prisma generate
npx prisma migrate dev
npm run dev
```

### 7.2 프로덕션 실행

```bash
npm install
npx prisma generate
npx prisma migrate deploy
pm2 start ecosystem.config.js --only core-server --env production
```

### 7.3 PM2 설정

[`ecosystem.config.js`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/ecosystem.config.js)에는 현재 다음 프로세스가 정의되어 있습니다.

- `core-server`
- `core-server-staging`

## 8. 배포 방법

현재 저장소에는 AWS EC2 환경을 전제로 한 배포 스크립트 [`deploy.sh`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/deploy.sh)가 포함되어 있습니다.

배포 순서:

1. 워킹 트리가 깨끗한지 확인
2. `main` 브랜치 최신 코드 fetch/pull
3. `npm ci` 또는 `npm install`
4. `.env.production` 로드
5. `npx prisma generate`
6. `npx prisma migrate deploy`
7. `pm2 start` 또는 `pm2 restart`
8. `pm2 save`

직접 수동 배포 시 최소 명령은 다음과 같습니다.

```bash
npm install
npx prisma migrate deploy
pm2 start ecosystem.config.js --only core-server --env production
```

## 9. API 구조 개요

공통 응답 형식:

```json
{
  "success": true,
  "data": {}
}
```

에러 형식:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Readable message"
  }
}
```

### 9.1 Health

- `GET /health`

### 9.2 Auth

- `POST /auth/signup`
- `POST /auth/login`
- `POST /auth/apple`
- `POST /auth/google`
- `POST /auth/forgot-password`
- `POST /auth/reset-password`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /auth/me`
- `DELETE /auth/me`

### 9.3 User

- `GET /users/me`
- `PATCH /users/me`
- `PATCH /users/me/profile-image`
- `DELETE /users/me/profile-image`
- `PATCH /auth/me`
- `PATCH /auth/me/profile-image`
- `DELETE /auth/me/profile-image`

### 9.4 Game / IGDB

- `GET /games/highlights`
- `GET /games/popular`
- `GET /games/recommended`
- `GET /games/search`
- `GET /games/suggestions`
- `GET /games/:id`

### 9.5 Review

- `POST /reviews`
- `GET /games/:gameId/reviews`
- `PATCH /reviews/:reviewId`
- `DELETE /reviews/:reviewId`
- `GET /users/me/reviews`

### 9.6 Favorite

- `POST /favorites`
- `DELETE /favorites/:gameId`
- `GET /users/me/favorites`
- `GET /games/:gameId/favorite-status`

### 9.7 Library

- `GET /users/me/library`
- `POST /users/me/library/status`
- `POST /users/me/library/steam/link`
- `DELETE /users/me/library/steam/link`
- `GET /library/steam/callback`

### 9.8 Moderation

- `POST /reports`
- `POST /users/:userId/block`
- `DELETE /users/:userId/block`

## 10. iOS 앱과의 연동 방식

기본 연동 방식:

1. iOS 앱이 로그인/회원가입 API를 호출합니다.
2. Core Server는 Access Token / Refresh Token을 발급합니다.
3. 앱은 Access Token을 저장하고 인증이 필요한 요청에 Bearer 토큰으로 포함합니다.
4. Access Token 만료 시 `/auth/refresh`로 토큰을 회전합니다.
5. 게임 검색/목록/상세/리뷰/찜/라이브러리 화면은 Core Server API를 직접 사용합니다.

Steam 연동 방식:

1. iOS 앱이 `POST /users/me/library/steam/link`를 호출합니다.
2. Core Server가 Steam OpenID 인증 URL을 생성해 반환합니다.
3. 앱은 해당 URL을 Safari/SFSafariViewController/웹뷰 등으로 엽니다.
4. Steam 인증 후 Core Server의 `/library/steam/callback`으로 돌아옵니다.
5. Core Server가 OpenID 검증 후 `social_accounts`에 Steam 계정을 연결합니다.
6. 이후 `GET /users/me/library`에서 최근 플레이 게임과 링크 상태를 함께 응답합니다.

번역 서버 연동 방식:

- 검색어 번역은 `search-query-translation.service.js`를 통해 처리됩니다.
- 검색 결과 번역은 `search-result-translation.service.js`를 통해 처리됩니다.
- 실제 번역 엔진/프록시는 별도 Translate Server 저장소가 담당합니다.

## 11. 보안 설계

### 11.1 JWT

- Access Token과 Refresh Token을 분리합니다.
- Access Token은 짧은 수명, Refresh Token은 긴 수명을 가집니다.
- 보호된 라우트는 Access Token 검증이 필요합니다.

### 11.2 Refresh Token Rotation

- `/auth/refresh` 호출 시 기존 Refresh Token을 revoke 처리합니다.
- 새 Refresh Token을 재발급하여 재사용 공격 위험을 줄입니다.
- Refresh Token 원문은 DB에 저장하지 않고 SHA-256 해시만 저장합니다.

### 11.3 비밀번호 저장

- 비밀번호는 bcrypt로 해시합니다.
- 원문 비밀번호는 저장하지 않습니다.

### 11.4 비밀번호 재설정

- 비밀번호 재설정 토큰은 별도 테이블에 저장됩니다.
- 만료 시간과 사용 여부를 관리합니다.
- 사용 후 기존 세션을 정리합니다.

### 11.5 소셜 로그인 검증

- Apple / Google ID 토큰은 서버에서 직접 검증합니다.
- Steam 계정 연동도 서버에서 OpenID 검증을 수행합니다.
- 외부 인증 공급자 토큰 검증 로직은 클라이언트가 아니라 Core Server에 있습니다.

### 11.6 입력 검증 및 에러 처리

- Zod 기반 요청 검증
- 공통 `AppError` 기반 예외 응답
- Prisma unique constraint 등 공통 에러 매핑

## 12. 데이터베이스 개요

주요 테이블 역할:

- `users`
  - 사용자 계정
- `refresh_tokens`
  - 장치별 세션 관리
- `password_reset_tokens`
  - 비밀번호 재설정 토큰
- `social_accounts`
  - Apple / Google / Steam 외부 계정 연결
- `reviews`
  - 사용자 리뷰
- `favorite_games`
  - 찜 게임
- `user_game_library`
  - 플레이 중 / 완료 / 중단 상태
- `reports`
  - 신고 데이터
- `user_blocks`
  - 차단 관계
- `search_queries`
  - 검색 기록

## 13. 캐싱 및 외부 연동 메모

- IGDB 검색 결과와 자동완성 결과는 현재 Redis가 아니라 메모리 `Map` 기반 캐시를 사용합니다.
- `REDIS_URL`은 현재 서버 시작 시 연결 확인 용도로만 사용됩니다.
- 게임 메타데이터는 IGDB/Twitch API에서 가져옵니다.
- 최근 플레이 게임은 Steam Web API에서 가져옵니다.
- 번역은 별도 Translate Server 또는 프록시를 통해 수행합니다.

## 14. 향후 확장 가능 구조

현재 구조는 다음 방향으로 확장하기 쉽도록 되어 있습니다.

- `modules/` 단위 도메인 확장
  - 예: comment, notification, achievement, follow
- `library` 모듈 확장
  - Steam owned games, completed/dropped 목록, 플랫폼별 라이브러리 연동
- `igdb` 모듈 확장
  - 필터 검색, 장르/플랫폼 기반 탐색, 상세 캐시 강화
- 인증 확장
  - 추가 소셜 로그인 공급자 연동
- 인프라 확장
  - Redis 실사용 캐시 도입
  - 작업 큐/비동기 이벤트 처리
  - S3 기반 프로필 이미지 저장
- 관측성 확장
  - 메트릭, 트레이싱, 중앙 로그 수집

## 15. 참고

- 실제 런타임 진입점: [`src/server.js`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/src/server.js)
- Express 앱 구성: [`src/app.js`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/src/app.js)
- Prisma 스키마: [`prisma/schema.prisma`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/prisma/schema.prisma)
- 배포 스크립트: [`deploy.sh`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/deploy.sh)
- PM2 설정: [`ecosystem.config.js`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/ecosystem.config.js)
