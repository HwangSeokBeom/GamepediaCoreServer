# GamePedia Core Server 현재 실제 운영용 수동 배포 가이드

이 문서는 **현재 실제 운영 기준**인 수동 배포 절차를 정리한다.

- 운영자는 로컬에서 `dev -> staging -> main` 순서로 머지한다.
- EC2 에 직접 SSH 접속해서 `git 동기화 + pm2 restart` 중심으로 배포한다.
- `self-hosted runner` 자동배포는 당분간 사용하지 않으며, service 는 `inactive/dead` 상태로 유지한다.
- 자동배포 구조 참고가 필요하면 [`docs/cicd.md`](./cicd.md)를 본다. 현재 실제 운영 절차의 기준 문서는 이 문서다.

## 1. EC2 접속부터 시작

현재 퍼블릭 IP 를 EC2 콘솔에서 먼저 확인한 뒤 접속한다.

```bash
ssh -i ~/Downloads/GamePedia.pem ec2-user@<PUBLIC_IP>
```

SSH host key 충돌이 나면 로컬에서 `known_hosts` 를 정리한 뒤 다시 접속한다.

```bash
ssh-keygen -R <PUBLIC_IP>
ssh-keygen -R gamepedia-api.duckdns.org
ssh-keygen -R staging-gamepedia-api.duckdns.org
```

접속 직후 기본 확인:

```bash
hostname
pwd
pm2 list
```

접속 실패 시 점검 포인트:

- EC2 인스턴스가 `running` 상태인지 확인
- 현재 퍼블릭 IP 가 바뀌지 않았는지 확인
- 보안그룹에서 `22/tcp` 가 현재 운영자 IP `/32` 로 열려 있는지 확인
- PEM 경로와 권한이 맞는지 확인: `chmod 400 ~/Downloads/GamePedia.pem`
- 접속 사용자가 `ec2-user` 인지 확인

## 2. 운영 기준 요약

| 구분 | staging | production |
| --- | --- | --- |
| 서버 clone 경로 | `~/GamePediaCoreServer-staging` | `~/GamePediaCoreServer-prod` |
| 배포 브랜치 | `staging` | `main` |
| PM2 app name | `core-server-staging` | `core-server` |
| 포트 | `3101` | `3001` |
| 도메인 | `staging-gamepedia-api.duckdns.org` | `gamepedia-api.duckdns.org` |
| PostgreSQL DB | `gamepedia_core_staging` | `gamepedia_core` |
| PM2 cwd 기대값 | `~/GamePediaCoreServer-staging` | `~/GamePediaCoreServer-prod` |

기본 원칙:

- 배포는 항상 `staging` 을 먼저 반영하고 검증한 뒤 `production` 으로 올린다.
- 평소 배포는 빠른 절차를 사용한다.
- `package.json`, `package-lock.json`, `prisma`, `.env`, `ecosystem.config.js`, PM2 설정이 바뀐 경우에만 확장 절차를 사용한다.
- `curl GET /` 응답이 `NOT_FOUND` JSON 이면 서버 프로세스는 정상적으로 떠 있다고 판단한다.

## 3. 로컬 운영 흐름

권장 반영 순서:

1. `feature/*`, `fix/*` 변경을 `dev` 에 반영한다.
2. 로컬 검증이 끝나면 `dev -> staging` 으로 머지한다.
3. `staging` 을 EC2 에 수동 배포하고 검증한다.
4. `staging` 검증이 끝나면 `staging -> main` 으로 머지한다.
5. `main` 을 EC2 production 에 수동 반영한다.

기본 예시:

```bash
git checkout dev
git pull origin dev

# dev 기준 작업 및 검증 완료 후
git checkout staging
git pull origin staging
git merge --no-ff dev
git push origin staging

# staging 배포 및 검증 완료 후
git checkout main
git pull origin main
git merge --no-ff staging
git push origin main
```

운영 브랜치 반영 원칙:

- 운영 배포 전 검증은 항상 `staging` 에서 먼저 끝낸다.
- `production` 에서 문제를 발견했더라도 브랜치 정리는 `main`, `staging`, `dev` 순으로 다시 맞춘다.
- 긴급 수정도 가능하면 `staging` 검증 후 `main` 으로 올린다. 정말 긴급하면 `main` 우선 반영 후 즉시 `staging`, `dev` 에 역반영한다.

## 4. Staging 수동 배포

### 4.1 빠른 배포 절차

일반 코드 수정만 있고, 의존성/Prisma/env/PM2 설정 변경이 없을 때 사용한다.

```bash
ssh -i ~/Downloads/GamePedia.pem ec2-user@<PUBLIC_IP>

cd ~/GamePediaCoreServer-staging
pwd
git fetch origin
git reset --hard origin/staging
pm2 restart core-server-staging
pm2 status core-server-staging
pm2 describe core-server-staging | grep "exec cwd"
curl http://localhost:3101
curl http://staging-gamepedia-api.duckdns.org
```

확인 기준:

- `pwd` 는 `~/GamePediaCoreServer-staging`
- `exec cwd` 는 `~/GamePediaCoreServer-staging`
- `curl` 응답이 `NOT_FOUND` JSON 이면 프로세스는 정상 기동

### 4.2 `package.json` / `package-lock.json` 변경 시 확장 절차

```bash
ssh -i ~/Downloads/GamePedia.pem ec2-user@<PUBLIC_IP>

cd ~/GamePediaCoreServer-staging
pwd
git fetch origin
git reset --hard origin/staging
npm ci --omit=dev --omit=optional
pm2 restart core-server-staging
pm2 status core-server-staging
pm2 describe core-server-staging | grep "exec cwd"
curl http://localhost:3101
curl http://staging-gamepedia-api.duckdns.org
```

### 4.3 Prisma 변경 시 확장 절차

Prisma 관련 변경은 반드시 `staging` 에 먼저 반영하고 검증한 뒤 `production` 으로 올린다.

```bash
ssh -i ~/Downloads/GamePedia.pem ec2-user@<PUBLIC_IP>

cd ~/GamePediaCoreServer-staging
pwd
git fetch origin
git reset --hard origin/staging
npm ci --omit=dev --omit=optional
NODE_ENV=staging npx prisma generate

# migration 파일이 포함된 경우에만 실행
NODE_ENV=staging npx prisma migrate deploy

pm2 restart core-server-staging
pm2 status core-server-staging
pm2 describe core-server-staging | grep "exec cwd"
curl http://localhost:3101
curl http://staging-gamepedia-api.duckdns.org
```

### 4.4 `.env` / `ecosystem.config.js` / PM2 관련 변경 시 확장 절차

환경 변수 로딩이나 PM2 등록 정보 자체가 바뀐 경우에는 `restart` 대신 `delete -> start -> save` 로 재등록한다.

```bash
ssh -i ~/Downloads/GamePedia.pem ec2-user@<PUBLIC_IP>

cd ~/GamePediaCoreServer-staging
pwd
git fetch origin
git reset --hard origin/staging
npm ci --omit=dev --omit=optional

set -a
[ -f .env ] && source .env
[ -f .env.local ] && source .env.local
source .env.staging
[ -f .env.staging.local ] && source .env.staging.local
set +a

export NODE_ENV=staging

pm2 delete core-server-staging || true
CORE_SERVER_STAGING_CWD="$HOME/GamePediaCoreServer-staging" pm2 start ecosystem.config.js --only core-server-staging --env staging
pm2 save

pm2 status core-server-staging
pm2 describe core-server-staging | grep "exec cwd"
curl http://localhost:3101
curl http://staging-gamepedia-api.duckdns.org
```

## 5. Production 수동 배포

`production` 은 **반드시 staging 성공 후에만** 반영한다.

### 5.1 빠른 배포 절차

일반 코드 수정만 있고, 의존성/Prisma/env/PM2 설정 변경이 없을 때 사용한다.

```bash
ssh -i ~/Downloads/GamePedia.pem ec2-user@<PUBLIC_IP>

cd ~/GamePediaCoreServer-prod
pwd
git fetch origin
git reset --hard origin/main
pm2 restart core-server
pm2 status core-server
pm2 describe core-server | grep "exec cwd"
curl http://localhost:3001
curl http://gamepedia-api.duckdns.org
```

확인 기준:

- `pwd` 는 `~/GamePediaCoreServer-prod`
- `exec cwd` 는 `~/GamePediaCoreServer-prod`
- `curl` 응답이 `NOT_FOUND` JSON 이면 프로세스는 정상 기동

### 5.2 `package.json` / `package-lock.json` 변경 시 확장 절차

```bash
ssh -i ~/Downloads/GamePedia.pem ec2-user@<PUBLIC_IP>

cd ~/GamePediaCoreServer-prod
pwd
git fetch origin
git reset --hard origin/main
npm ci --omit=dev --omit=optional
pm2 restart core-server
pm2 status core-server
pm2 describe core-server | grep "exec cwd"
curl http://localhost:3001
curl http://gamepedia-api.duckdns.org
```

### 5.3 Prisma 변경 시 확장 절차

Prisma 변경은 반드시 `staging` 검증 완료 후에만 production 에 반영한다.

```bash
ssh -i ~/Downloads/GamePedia.pem ec2-user@<PUBLIC_IP>

cd ~/GamePediaCoreServer-prod
pwd
git fetch origin
git reset --hard origin/main
npm ci --omit=dev --omit=optional
NODE_ENV=production npx prisma generate

# staging 에서 검증된 migration 만 실행
NODE_ENV=production npx prisma migrate deploy

pm2 restart core-server
pm2 status core-server
pm2 describe core-server | grep "exec cwd"
curl http://localhost:3001
curl http://gamepedia-api.duckdns.org
```

### 5.4 `.env` / `ecosystem.config.js` / PM2 관련 변경 시 확장 절차

```bash
ssh -i ~/Downloads/GamePedia.pem ec2-user@<PUBLIC_IP>

cd ~/GamePediaCoreServer-prod
pwd
git fetch origin
git reset --hard origin/main
npm ci --omit=dev --omit=optional

set -a
[ -f .env ] && source .env
[ -f .env.local ] && source .env.local
source .env.production
[ -f .env.production.local ] && source .env.production.local
set +a

export NODE_ENV=production

pm2 delete core-server || true
CORE_SERVER_PRODUCTION_CWD="$HOME/GamePediaCoreServer-prod" pm2 start ecosystem.config.js --only core-server --env production
pm2 save

pm2 status core-server
pm2 describe core-server | grep "exec cwd"
curl http://localhost:3001
curl http://gamepedia-api.duckdns.org
```

## 6. 문제 발생 시 점검 명령 모음

공통 점검:

```bash
pm2 list
pm2 describe core-server
pm2 describe core-server-staging
pm2 logs core-server --lines 100
pm2 logs core-server-staging --lines 100
free -h
df -h
ss -tlnp | grep 3001
ss -tlnp | grep 3101
```

브랜치와 현재 위치 재확인:

```bash
cd ~/GamePediaCoreServer-prod
pwd
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD

cd ~/GamePediaCoreServer-staging
pwd
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
```

### 6.1 자주 쓰는 예외 대응

PM2 `cwd` 가 틀린 경우:

```bash
cd ~/GamePediaCoreServer-staging
pm2 delete core-server-staging || true
CORE_SERVER_STAGING_CWD="$HOME/GamePediaCoreServer-staging" pm2 start ecosystem.config.js --only core-server-staging --env staging
pm2 save
pm2 describe core-server-staging | grep "exec cwd"
```

직전 정상 커밋으로 staging 롤백:

```bash
cd ~/GamePediaCoreServer-staging
git log --oneline -n 5
git reset --hard <LAST_GOOD_SHA>
pm2 restart core-server-staging
curl http://localhost:3101
curl http://staging-gamepedia-api.duckdns.org
```

직전 정상 커밋으로 production 롤백:

```bash
cd ~/GamePediaCoreServer-prod
git log --oneline -n 5
git reset --hard <LAST_GOOD_SHA>
pm2 restart core-server
curl http://localhost:3001
curl http://gamepedia-api.duckdns.org
```

## 7. Self-Hosted Runner 현재 운영 방침

현재는 자동배포를 비활성화하고, **수동 배포를 기본 운영 방식**으로 둔다.

- runner service 는 `inactive/dead` 상태 유지가 기본이다.
- 배포는 GitHub Actions 가 아니라 운영자의 SSH 접속과 수동 명령으로 수행한다.
- 자동배포 문서는 삭제하지 않고 참고용으로만 유지한다.

runner 상태 확인:

```bash
cd ~/actions-runner/gamepedia-core-deploy
sudo ./svc.sh status
sudo systemctl status actions.runner.* --no-pager
```

runner 중지:

```bash
cd ~/actions-runner/gamepedia-core-deploy
sudo ./svc.sh stop
```

runner disable:

```bash
sudo systemctl list-unit-files 'actions.runner*'
sudo systemctl disable <RUNNER_SERVICE_NAME> --now
sudo systemctl status <RUNNER_SERVICE_NAME> --no-pager
```

## 8. 보안그룹 / 도메인 / 네트워크 주의사항

- SSH `22/tcp` 는 가능하면 운영자 고정 IP `/32` 만 허용한다.
- `80/443` 은 서비스 정책에 맞게 공개한다.
- EC2 `stop/start` 이후 퍼블릭 IP 가 바뀔 수 있으므로, 접속 전 EC2 콘솔과 DuckDNS 레코드를 먼저 확인한다.
- 퍼블릭 IP 가 바뀌면 SSH 접속 대상 IP 와 DuckDNS 두 도메인 모두 점검한다.
- 퍼블릭 IP 변경이 잦으면 `Elastic IP` 사용을 검토한다.

로컬에서 도메인 확인:

```bash
nslookup gamepedia-api.duckdns.org
nslookup staging-gamepedia-api.duckdns.org
```

SSH 접속 IP 가 바뀐 뒤 재접속:

```bash
ssh-keygen -R <OLD_PUBLIC_IP>
ssh -i ~/Downloads/GamePedia.pem ec2-user@<NEW_PUBLIC_IP>
```

## 9. 운영자가 가장 자주 쓰는 명령어 세트

staging 빠른 배포:

```bash
ssh -i ~/Downloads/GamePedia.pem ec2-user@<PUBLIC_IP>
cd ~/GamePediaCoreServer-staging
git fetch origin
git reset --hard origin/staging
pm2 restart core-server-staging
pm2 describe core-server-staging | grep "exec cwd"
curl http://localhost:3101
curl http://staging-gamepedia-api.duckdns.org
```

production 빠른 배포:

```bash
ssh -i ~/Downloads/GamePedia.pem ec2-user@<PUBLIC_IP>
cd ~/GamePediaCoreServer-prod
git fetch origin
git reset --hard origin/main
pm2 restart core-server
pm2 describe core-server | grep "exec cwd"
curl http://localhost:3001
curl http://gamepedia-api.duckdns.org
```
