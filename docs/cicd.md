# GamePedia Core Server CI/CD

## 1. 목표 구조

이 저장소의 운영 기준 구조는 다음과 같습니다.

| 구분 | 브랜치 | 서버 디렉토리 | PM2 | 포트 | PostgreSQL DB | 도메인 |
| --- | --- | --- | --- | --- | --- | --- |
| production | `main` | `~/GamePediaCoreServer-prod` | `core-server` | `3001` | `gamepedia_core` | `gamepedia-api.duckdns.org` |
| staging | `staging` | `~/GamePediaCoreServer-staging` | `core-server-staging` | `3101` | `gamepedia_core_staging` | `staging-gamepedia-api.duckdns.org` |

핵심 원칙:

- production 과 staging 은 같은 EC2 인스턴스를 사용해도 코드 디렉토리는 공유하지 않습니다.
- production 배포는 `main` 만 반영합니다.
- staging 배포는 `staging` 만 반영합니다.
- nginx 는 그대로 `127.0.0.1:3001` / `127.0.0.1:3101` 으로 프록시합니다.

## 2. 분리 방식 선택

이번 저장소는 `git worktree` 대신 별도 clone 방식을 기준으로 맞췄습니다.

선택 이유:

- 별도 clone 이 운영자가 이해하기 가장 쉽습니다.
- 각 디렉토리가 자체 `.git`, branch, `node_modules`, env 파일을 가지므로 branch 충돌 위험이 가장 낮습니다.
- PM2 `cwd` 와 GitHub Actions 원격 경로를 고정값으로 맞추기 쉽습니다.
- 장애 시 특정 clone 만 점검하거나 교체하기 쉬워집니다.

## 3. 저장소 안에서 바뀐 배포 파일

- `.github/workflows/deploy.yml`
- `deploy.sh`
- `deploy-staging.sh`
- `scripts/server/deploy-instance.sh`
- `scripts/server/bootstrap-clones.sh`
- `ecosystem.config.js`
- `.env.example`
- `.env.production.example`
- `.env.staging.example`

동작 요약:

- GitHub Actions 는 `main` push 시 `~/GamePediaCoreServer-prod/deploy.sh` 를 실행합니다.
- GitHub Actions 는 `staging` push 시 `~/GamePediaCoreServer-staging/deploy-staging.sh` 를 실행합니다.
- 각 배포 스크립트는 전용 디렉토리명, 전용 branch, 전용 DB 이름, 전용 public URL, 전용 PM2 앱 이름을 검증합니다.
- `package-lock.json` 이 있으면 `npm ci`, 없으면 `npm install` 을 실행합니다.

## 4. 서버 준비 절차

### 4.1 필수 런타임

다음 서비스/도구가 EC2 `us-east-1` 서버에 설치 및 정상 기동되어 있어야 합니다.

- Node.js 20+
- npm
- git
- PM2
- PostgreSQL
- Redis
- nginx

### 4.2 코드 디렉토리 생성

기존 공유 clone (`~/GamePediaCoreServer`) 가 이미 있다면 그 안에서 다음 명령으로 두 개의 전용 clone 을 생성할 수 있습니다.

```bash
cd ~/GamePediaCoreServer
bash scripts/server/bootstrap-clones.sh
```

직접 clone 할 수도 있습니다.

```bash
git clone <repo-url> ~/GamePediaCoreServer-prod
git -C ~/GamePediaCoreServer-prod checkout main

git clone <repo-url> ~/GamePediaCoreServer-staging
git -C ~/GamePediaCoreServer-staging checkout staging
```

### 4.3 환경 변수 파일

애플리케이션과 Prisma CLI 는 모두 아래 순서로 env 를 읽습니다.

1. `.env`
2. `.env.local`
3. `.env.${NODE_ENV}`
4. `.env.${NODE_ENV}.local`

권장 방식:

- 공통 기본값: `.env.production`, `.env.staging`
- 서버별 override / 비밀값: `.env.production.local`, `.env.staging.local`

파일 우선순위는 아래와 같습니다. 아래쪽일수록 최종 우선순위가 높습니다.

1. `.env`
2. `.env.local`
3. `.env.${NODE_ENV}`
4. `.env.${NODE_ENV}.local`

환경별 필수 파일은 다음과 같습니다.

| clone | 반드시 있어야 하는 파일 | 선택 파일 | 최종 우선순위 |
| --- | --- | --- | --- |
| `~/GamePediaCoreServer-prod` | `.env.production` 또는 `.env.production.local` | `.env`, `.env.local` | `.env.production.local` > `.env.production` > `.env.local` > `.env` |
| `~/GamePediaCoreServer-staging` | `.env.staging` 또는 `.env.staging.local` | `.env`, `.env.local` | `.env.staging.local` > `.env.staging` > `.env.local` > `.env` |

예시 파일:

- production: [`.env.production.example`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/.env.production.example)
- staging: [`.env.staging.example`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/.env.staging.example)

### 4.4 PM2 등록

각 clone 디렉토리에서 한 번씩 배포 래퍼를 실행하면 PM2 가 새 `cwd` 기준으로 등록됩니다.

```bash
cd ~/GamePediaCoreServer-prod
./deploy.sh

cd ~/GamePediaCoreServer-staging
./deploy-staging.sh
```

이후 확인:

```bash
pm2 status core-server
pm2 status core-server-staging
pm2 save
```

## 5. GitHub Actions 배포 흐름

워크플로우 파일: [`.github/workflows/deploy.yml`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/.github/workflows/deploy.yml)

동작:

1. `main` 또는 `staging` push 시 validate job 이 `npm ci`, `npm test --if-present`, `npm run lint --if-present` 를 수행합니다.
2. `main` 이면 production job 만 실행됩니다.
3. `staging` 이면 staging job 만 실행됩니다.
4. GitHub Actions 는 `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY` 로 EC2 에 SSH 접속합니다.
5. 원격 서버에서 전용 디렉토리 존재 여부, 디렉토리명, 현재 git branch 를 먼저 검증합니다.
6. 검증 통과 시에만 전용 디렉토리의 배포 래퍼를 실행합니다.

GitHub Secrets 는 반드시 현재 `us-east-1` EC2 를 가리켜야 합니다.

## 6. 배포 스크립트 동작

공통 로직 파일: [`scripts/server/deploy-instance.sh`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/scripts/server/deploy-instance.sh)

각 환경에서 다음을 강제합니다.

- 전용 디렉토리 이름 검증
- 현재 clone 이 올바른 branch (`main` 또는 `staging`) 인지 fail-fast 검증
- `git pull --ff-only`
- `package-lock.json` 이 있으면 `npm ci`, 없으면 `npm install`
- env 파일 로드
- 환경별 전용 env 파일 (`.env.production(.local)` / `.env.staging(.local)`) 존재 검증
- DB 이름, public URL, port 검증
- `npx prisma generate`
- `SKIP_PRISMA_MIGRATE_DEPLOY=1` 이 아니면 `npx prisma migrate deploy`
- 기존 PM2 프로세스의 `pm_cwd` 가 다르면 delete 후 start 로 재등록
- `FORCE_PM2_RECREATE=1` 이면 PM2 프로세스를 강제로 delete 후 start
- `pm2 save`

수동 배포:

```bash
cd ~/GamePediaCoreServer-prod
./deploy.sh

cd ~/GamePediaCoreServer-staging
./deploy-staging.sh
```

### 6.1 SQL dump 복구 직후의 Prisma 점검

Prisma 공식 문서 기준으로 `migrate deploy` 는 production/test 환경에서 pending migration 적용 용도로 사용하는 것이 맞지만, drift 는 감지하지 못합니다. 또한 기존 DB 를 Prisma Migrate 에 붙이는 경우에는 `_prisma_migrations` 를 baseline / resolve 로 맞춰 두어야 합니다. 복구 직후 DB 가 SQL dump 로만 되살아났고 `_prisma_migrations` 상태가 불확실하다면, 바로 `migrate deploy` 를 돌리는 것은 안전하지 않을 수 있습니다.

점검 절차:

```sql
SELECT migration_name, finished_at, rolled_back_at
FROM _prisma_migrations
ORDER BY finished_at NULLS FIRST, migration_name;
```

확인 기준:

- 최신 dump 복구 후 `_prisma_migrations` 가 비어 있거나 누락되면 baseline/resolve 없이 바로 `migrate deploy` 하지 않습니다.
- `_prisma_migrations` 에 실패 흔적이 있으면 `rolled_back_at`, `logs` 를 먼저 점검합니다.
- 현재 `prisma/migrations` 디렉토리와 DB 의 end-state 가 같아야 안전합니다.

복구 직후 1회 배포에서 migration 을 건너뛰려면:

```bash
cd ~/GamePediaCoreServer-prod
SKIP_PRISMA_MIGRATE_DEPLOY=1 ./deploy.sh
```

baseline 이 필요한 경우 Prisma 공식 절차처럼 `prisma migrate resolve --applied <migration>` 으로 `_prisma_migrations` 를 맞춘 다음부터 `migrate deploy` 를 재개해야 합니다.

## 7. nginx 기준값

저장소 안에 nginx 설정 파일은 없으므로, 서버에는 아래와 같은 reverse proxy 구조가 유지되어야 합니다.

```nginx
server {
    listen 80;
    server_name gamepedia-api.duckdns.org;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name staging-gamepedia-api.duckdns.org;

    location / {
        proxy_pass http://127.0.0.1:3101;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

변경 후 확인:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 8. DuckDNS / 외부 접근

- `gamepedia-api.duckdns.org` 는 현재 EC2 public IP 를 가리켜야 합니다.
- `staging-gamepedia-api.duckdns.org` 도 같은 EC2 public IP 를 가리켜야 합니다.
- Security Group 은 80/443 과 SSH 접근 정책을 현재 운영 기준에 맞게 열어야 합니다.

## 9. 롤백 절차

중요:

- 이 저장소의 배포 스크립트는 forward-only Prisma 마이그레이션을 사용합니다.
- 코드만 되돌리는 임시 롤백은 가능하지만, 이미 적용된 스키마 변경과 충돌할 수 있습니다.
- DB 문제까지 포함한 롤백은 백업 복구 또는 fix-forward migration 을 기준으로 판단해야 합니다.

임시 코드 롤백 예시:

```bash
cd ~/GamePediaCoreServer-prod
git log --oneline -n 10
git checkout <last-known-good-commit>
npm ci
NODE_ENV=production npx prisma generate
pm2 restart ecosystem.config.js --only core-server --env production --update-env
pm2 save
```

주의:

- 위 방법은 서버에서만 임시 복구하는 방식입니다.
- 다음 CI/CD 실행 시 branch HEAD 가 다시 배포되므로, Git 저장소에서도 `revert` 또는 fix-forward 커밋을 만들어야 합니다.

## 10. 신규 서버 재구성 체크

1. `us-east-1` EC2 생성 및 SSH 접속 확인
2. Node.js 20, npm, git, PM2 설치
3. PostgreSQL / Redis / nginx 설치 및 기동
4. DuckDNS 가 새 public IP 를 가리키도록 갱신
5. 저장소를 `~/GamePediaCoreServer-prod`, `~/GamePediaCoreServer-staging` 로 각각 clone
6. `.env.production(.local)` / `.env.staging(.local)` 작성
7. PM2 등록 및 `pm2 save`
8. nginx 프록시 설정 적용
9. GitHub Secrets 의 `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY` 를 새 서버 기준으로 갱신
10. `main` 과 `staging` 에서 각각 테스트 배포 수행

## 11. 최초 1회 전환 체크

기존 PM2 프로세스가 옛 `~/GamePediaCoreServer` `cwd` 를 들고 있을 수 있으므로, 최초 1회 전환 때는 recreate 기준으로 맞추는 것이 가장 안전합니다.

권장 순서:

```bash
cd ~/GamePediaCoreServer
bash scripts/server/bootstrap-clones.sh

pm2 delete core-server || true
pm2 delete core-server-staging || true

cd ~/GamePediaCoreServer-prod
FORCE_PM2_RECREATE=1 SKIP_PRISMA_MIGRATE_DEPLOY=1 ./deploy.sh

cd ~/GamePediaCoreServer-staging
FORCE_PM2_RECREATE=1 SKIP_PRISMA_MIGRATE_DEPLOY=1 ./deploy-staging.sh

pm2 status core-server
pm2 status core-server-staging
pm2 save
```

그 다음:

- `_prisma_migrations` 점검이 끝나면 `SKIP_PRISMA_MIGRATE_DEPLOY` 없이 정상 배포로 전환합니다.
- 이후부터는 `FORCE_PM2_RECREATE` 없이 일반 `./deploy.sh`, `./deploy-staging.sh` 를 사용합니다.
