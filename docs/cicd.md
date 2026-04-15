# GamePedia Core Server CI/CD

## 1. 운영 기준

| 구분 | 브랜치 | 서버 clone | PM2 app | 포트 | PostgreSQL DB | 도메인 |
| --- | --- | --- | --- | --- | --- | --- |
| production | `main` | `~/GamePediaCoreServer-prod` | `core-server` | `3001` | `gamepedia_core` | `https://gamepedia-api.duckdns.org` |
| staging | `staging` | `~/GamePediaCoreServer-staging` | `core-server-staging` | `3101` | `gamepedia_core_staging` | `https://staging-gamepedia-api.duckdns.org` |

핵심 제약:

- production 과 staging 은 같은 EC2 에 있어도 working tree 를 공유하지 않습니다.
- deploy job 은 EC2 내부 self-hosted runner 에서만 실행합니다.
- validate job 은 GitHub-hosted runner(`ubuntu-latest`) 에서 실행합니다.
- GitHub-hosted runner 가 EC2 에 SSH 접속하는 구조는 사용하지 않습니다.
- PM2 `cwd` 는 각 clone 경로와 정확히 일치하지 않으면 배포를 실패시킵니다.

## 2. 최종 배포 구조

현재 저장소는 아래 구조를 기준으로 동작합니다.

1. `main` 또는 `staging` push 발생
2. GitHub-hosted `validate` job 에서 `npm ci`, `npm test --if-present`, `npm run lint --if-present` 실행
3. branch 에 맞는 self-hosted deploy job 만 실행
4. EC2 내부 runner 가 전용 clone 에서만 `git fetch` 와 `git reset --hard <github.sha>` 수행
5. 전용 clone 의 `deploy.sh` 또는 `deploy-staging.sh` 가 배포 본작업 수행
6. 배포 스크립트가 `npm ci`, env 검증, Prisma, PM2 restart/start/save 수행

중요:

- workflow 가 git 동기화의 유일한 주체입니다.
- `scripts/server/deploy-instance.sh` 는 더 이상 `git fetch` / `git pull` 을 하지 않습니다.
- env 파일은 bash `source` 로 읽지 않고 Node `dotenv` 로 앱과 같은 순서로 검증합니다.

## 3. Workflow 동작

워크플로우 파일: [`.github/workflows/deploy.yml`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/.github/workflows/deploy.yml)

### 3.1 validate job

- `runs-on: ubuntu-latest`
- `actions/checkout@v4`
- `actions/setup-node@v4`
- `npm ci`
- `npm test --if-present`
- `npm run lint --if-present`

### 3.2 deploy-production job

- `if: github.ref == 'refs/heads/main'`
- `runs-on: [self-hosted, linux, x64, gamepedia-core, deploy, ec2-us-east-1]`
- `environment: production`
- 동작 clone: `~/GamePediaCoreServer-prod`
- 동작 브랜치: `main`

job 내부에서 먼저 아래 검증을 합니다.

- 대상 디렉토리가 실제 git clone 인지
- 디렉토리명이 `GamePediaCoreServer-prod` 인지
- tracked 변경분이 없는지
- 현재 checkout branch 가 `main` 인지

검증 후에는 아래만 수행합니다.

- `git fetch --no-tags --prune origin "+refs/heads/main:refs/remotes/origin/main" "${GITHUB_SHA}"`
- `git checkout main`
- `git reset --hard "${GITHUB_SHA}"`
- `./deploy.sh`

### 3.3 deploy-staging job

- `if: github.ref == 'refs/heads/staging'`
- `runs-on: [self-hosted, linux, x64, gamepedia-core, deploy, ec2-us-east-1]`
- `environment: staging`
- 동작 clone: `~/GamePediaCoreServer-staging`
- 동작 브랜치: `staging`

검증과 git 동기화 방식은 production 과 동일하지만 대상 clone 과 branch 만 다릅니다.

### 3.4 SSH secrets 제거

이제 workflow 에서는 아래 값이 더 이상 필요하지 않습니다.

- `EC2_HOST`
- `EC2_USER`
- `EC2_SSH_KEY`

배포 job 이 EC2 내부에서 직접 실행되므로 inbound SSH 는 운영자 접속용으로만 유지하면 됩니다.

### 3.5 GitHub Environment 변수

deploy job 은 GitHub `environment` 의 `vars` 도 함께 읽습니다.

- `SKIP_PRISMA_MIGRATE_DEPLOY`
- `FORCE_PM2_RECREATE`

기본값은 둘 다 `0` 으로 간주됩니다. 따라서 평소에는 값을 비워 두고, 최초 전환이나 Prisma baseline 점검 기간에만 일시적으로 설정하는 것을 권장합니다.

## 4. Deploy Script 동작

공통 배포 스크립트: [`scripts/server/deploy-instance.sh`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/scripts/server/deploy-instance.sh)

환경별 래퍼:

- production: [`deploy.sh`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/deploy.sh)
- staging: [`deploy-staging.sh`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/deploy-staging.sh)

공통 스크립트가 수행하는 일:

1. 실행 위치가 환경 전용 clone 인지 검증
2. 현재 branch 가 환경 전용 branch 인지 검증
3. workflow 가 넘긴 `EXPECTED_GIT_SHA` 와 현재 `HEAD` 가 같은지 검증
4. `package-lock.json` 존재 검증 후 `npm ci`
5. Node `dotenv` 로 실제 앱 로딩 순서 그대로 env 검증
6. `NODE_ENV=<env> npx prisma generate`
7. 필요 시 `NODE_ENV=<env> npx prisma migrate deploy`
8. PM2 프로세스의 현재 `pm_cwd` 가 전용 clone 경로인지 검사
9. 다르면 delete 후 start, 맞으면 restart, 필요 시 `FORCE_PM2_RECREATE=1` 강제 재등록
10. start/restart 이후 PM2 `pm_cwd` 를 다시 읽어 최종 검증
11. `pm2 save`

중요:

- deploy script 는 네트워크에서 새 commit 을 가져오지 않습니다.
- deploy script 는 env 파일을 `source` 하지 않습니다.
- PM2 `cwd` 가 어긋난 상태면 그냥 restart 하지 않고 recreate 합니다.

## 5. Env 로딩 규칙

앱, Prisma, 배포 env 검증은 모두 아래 순서로 env 파일을 읽습니다.

1. `.env`
2. `.env.local`
3. `.env.${NODE_ENV}`
4. `.env.${NODE_ENV}.local`

예:

- production: `.env` -> `.env.local` -> `.env.production` -> `.env.production.local`
- staging: `.env` -> `.env.local` -> `.env.staging` -> `.env.staging.local`

필수 조건:

- production clone 에는 `.env.production` 또는 `.env.production.local` 이 반드시 있어야 합니다.
- staging clone 에는 `.env.staging` 또는 `.env.staging.local` 이 반드시 있어야 합니다.

배포 검증 기준:

- `DATABASE_URL` 의 DB 이름이 환경별 값과 일치해야 합니다.
- `APP_WEB_BASE_URL` 이 환경별 도메인과 일치해야 합니다.
- `API_PUBLIC_BASE_URL` 이 있으면 환경별 도메인과 일치해야 합니다.
- `PORT` 가 있으면 환경별 포트와 일치해야 합니다.

### 5.1 bash source 를 쓰지 않는 이유

과거에는 deploy script 가 `.env*` 파일을 bash `source` 했지만, 아래와 같은 값이 있으면 쉘 문법 오류가 날 수 있습니다.

```dotenv
MAIL_FROM=GamePedia <no-reply@example.com>
```

문제 포인트:

- 공백이 포함된 값
- `<`, `>`, `(`, `)`, `!`, `&` 같은 shell 메타문자
- quote escape 누락

현재 구조는 bash `source` 에 의존하지 않고 Node `dotenv` 로만 읽으므로 위 문제를 회피합니다.

## 6. Runner 라벨 전략

현재 권장 라벨:

- 기본: `self-hosted`, `linux`, `x64`
- 커스텀: `gamepedia-core`, `deploy`, `ec2-us-east-1`

이 저장소는 production/staging 을 한 EC2 에서 함께 운영하므로, runner 를 환경별로 두 개 설치할 필요는 없습니다.

권장 이유:

- `gamepedia-core`: 이 저장소 전용 runner 라우팅
- `deploy`: validate 와 구분되는 배포 전용 역할
- `ec2-us-east-1`: 잘못된 리전에 job 이 붙는 것 방지

상세 설치 절차는 [`docs/runner-setup.md`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/docs/runner-setup.md)를 따릅니다.

## 7. 최초 1회 전환 체크리스트

### 7.1 사전 준비

1. `~/GamePediaCoreServer-prod`, `~/GamePediaCoreServer-staging` 가 존재하는지 확인
2. 각 clone 의 env 파일 확인
3. `pm2 status core-server`, `pm2 status core-server-staging` 로 현재 상태 확인
4. GitHub repository `Settings -> Actions -> Runners` 에서 self-hosted runner 등록

### 7.2 clone 정리

기존 공유 clone 에서 부트스트랩이 필요하면:

```bash
cd ~/GamePediaCoreServer
bash scripts/server/bootstrap-clones.sh
```

### 7.3 staging 먼저 재등록

`staging` 을 먼저 새 cwd 로 재등록하고 검증합니다.

```bash
cd ~/GamePediaCoreServer-staging
FORCE_PM2_RECREATE=1 SKIP_PRISMA_MIGRATE_DEPLOY=1 ./deploy-staging.sh
pm2 status core-server-staging
pm2 jlist | node -e 'const fs=require("fs");const items=JSON.parse(fs.readFileSync(0,"utf8"));const app=items.find((entry)=>entry.name==="core-server-staging");console.log(app?.pm2_env?.pm_cwd || "missing");'
curl -I http://127.0.0.1:3101/health
curl -I https://staging-gamepedia-api.duckdns.org/health
```

확인 포인트:

- PM2 app 이름이 `core-server-staging` 인지
- `pm_cwd` 가 `~/GamePediaCoreServer-staging` 인지
- localhost 와 public staging domain 이 모두 응답하는지

### 7.4 staging workflow 검증

1. `staging` branch 에 테스트 commit push
2. Actions 에서 `validate` 는 GitHub-hosted runner, `deploy-staging` 은 self-hosted runner 로 실행되는지 확인
3. workflow 로그에서 SSH action 이 전혀 없음을 확인
4. EC2 에서 `pm2 logs core-server-staging --lines 100` 점검

### 7.5 production 전환

staging 검증이 끝난 뒤 production 을 재등록합니다.

```bash
cd ~/GamePediaCoreServer-prod
FORCE_PM2_RECREATE=1 SKIP_PRISMA_MIGRATE_DEPLOY=1 ./deploy.sh
pm2 status core-server
pm2 jlist | node -e 'const fs=require("fs");const items=JSON.parse(fs.readFileSync(0,"utf8"));const app=items.find((entry)=>entry.name==="core-server");console.log(app?.pm2_env?.pm_cwd || "missing");'
curl -I http://127.0.0.1:3001/health
curl -I https://gamepedia-api.duckdns.org/health
```

그 다음 `main` 에 테스트 반영을 수행합니다.

### 7.6 Prisma 안전장치

`_prisma_migrations` 상태가 불명확하거나 dump 복구 직후라면, 최초 전환에서는 `SKIP_PRISMA_MIGRATE_DEPLOY=1` 로 두고 먼저 애플리케이션/PM2/cwd 만 안정화합니다.

점검 SQL:

```sql
SELECT migration_name, finished_at, rolled_back_at
FROM _prisma_migrations
ORDER BY finished_at NULLS FIRST, migration_name;
```

정상화 이후에만 `SKIP_PRISMA_MIGRATE_DEPLOY` 없이 일반 배포로 전환합니다.

## 8. 롤백 방법

### 8.1 workflow 구조 롤백

새 self-hosted runner 방식이 문제를 만들면 다음 순서로 롤백합니다.

1. GitHub repository 에서 self-hosted deploy workflow 를 비활성화하거나 revert commit 을 push
2. 필요 시 self-hosted runner service 중지
3. 기존 SSH workflow 를 되살릴지, 아니면 수동 배포로 잠시 운영할지 결정

### 8.2 코드 롤백

staging 예시:

```bash
cd ~/GamePediaCoreServer-staging
git fetch --prune origin
git checkout staging
git reset --hard <last-known-good-sha>
SKIP_PRISMA_MIGRATE_DEPLOY=1 ./deploy-staging.sh
```

production 도 동일하게 `main` / `~/GamePediaCoreServer-prod` / `./deploy.sh` 기준으로 수행합니다.

주의:

- 이미 적용된 Prisma migration 은 자동 롤백되지 않습니다.
- 스키마 문제는 DB 백업 복구 또는 fix-forward migration 기준으로 판단해야 합니다.
- PM2 `cwd` 까지 흔들린 경우 `FORCE_PM2_RECREATE=1` 을 함께 사용합니다.

## 9. 보안그룹 권장 상태

권장 방향:

- `80/tcp`, `443/tcp`: 서비스 공개 정책에 맞게 허용
- `22/tcp`: 운영자 고정 IP 또는 VPN/bastion IP 만 허용
- GitHub Actions 용으로 `22/tcp` 를 `0.0.0.0/0` 에 열 필요 없음
- EC2 outbound `443/tcp`: GitHub 와 npm registry 접근을 위해 허용 필요

핵심 차이:

- 예전 구조는 GitHub-hosted runner 가 EC2 로 inbound SSH 해야 했습니다.
- 현재 구조는 EC2 가 GitHub 로 outbound HTTPS 하면 되므로 SSH 공개 범위를 대폭 줄일 수 있습니다.

## 10. 참고 문서

- self-hosted runner 설치/서비스화: [`docs/runner-setup.md`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/docs/runner-setup.md)
- PM2 설정: [`ecosystem.config.js`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/ecosystem.config.js)
- clone bootstrap: [`scripts/server/bootstrap-clones.sh`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/scripts/server/bootstrap-clones.sh)
