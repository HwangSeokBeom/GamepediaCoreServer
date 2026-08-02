# Self-Hosted Runner Setup

이 문서는 `us-east-1` EC2 내부에서 GamePediaCoreServer 배포용 GitHub Actions self-hosted runner 를 설치, 등록, 서비스화하는 절차를 정리합니다.

## 1. 목표

runner 는 아래 조건을 만족해야 합니다.

- EC2 내부에서 GitHub Actions deploy job 을 직접 실행
- production/staging 공용 배포 호스트로 동작
- `~/GamePediaCoreServer-prod`, `~/GamePediaCoreServer-staging` clone 을 그대로 사용
- SSH inbound 없이 GitHub outbound HTTPS 통신만으로 배포 가능

주의:

- self-hosted runner 는 GitHub-hosted runner 보다 신뢰 경계가 좁습니다.
- 이 저장소에서는 self-hosted runner job 을 `push` 기반 production/staging deploy 로만 제한합니다.
- `pull_request` 나 임의 실험 workflow 를 self-hosted runner 에 붙이지 않는 것을 권장합니다.

## 2. 권장 라벨

runner 등록 시 아래 라벨을 사용합니다.

- 기본 라벨: `self-hosted`, `linux`, `x64`
- 커스텀 라벨: `gamepedia-core`, `deploy`, `ec2-us-east-1`

현재 workflow 는 아래 조합을 요구합니다.

```yaml
runs-on:
  - self-hosted
  - linux
  - x64
  - gamepedia-core
  - deploy
  - ec2-us-east-1
```

## 3. 설치 위치

runner 는 배포 clone 과 분리된 별도 디렉토리에 설치합니다.

권장 예시:

```bash
mkdir -p ~/actions-runner/gamepedia-core-deploy
cd ~/actions-runner/gamepedia-core-deploy
```

하지 말아야 할 것:

- `~/GamePediaCoreServer-prod` 안에 runner 설치
- `~/GamePediaCoreServer-staging` 안에 runner 설치
- 기존 공유 clone `~/GamePediaCoreServer` 안에 runner 설치

## 4. 등록 절차

### 4.1 GitHub UI 에서 runner 생성

1. GitHub repository `HwangSeokBeom/GamePediaCoreServer` 로 이동
2. `Settings -> Actions -> Runners`
3. `New self-hosted runner`
4. `Linux` / `x64` 선택
5. GitHub 가 보여주는 다운로드 명령과 registration token 을 복사

중요:

- 다운로드 URL 과 token 은 시점마다 바뀌므로 문서에 하드코딩하지 않습니다.
- GitHub UI 가 제공하는 최신 명령을 그대로 사용합니다.

### 4.2 runner 바이너리 다운로드

GitHub UI 가 제시한 명령을 runner 디렉토리에서 실행합니다.

예시 형태:

```bash
cd ~/actions-runner/gamepedia-core-deploy
curl -o actions-runner-linux-x64-<version>.tar.gz -L <github-provided-url>
tar xzf ./actions-runner-linux-x64-<version>.tar.gz
```

### 4.3 runner configure

아래 형식으로 등록합니다.

```bash
cd ~/actions-runner/gamepedia-core-deploy
./config.sh \
  --url https://github.com/HwangSeokBeom/GamePediaCoreServer \
  --token <github-provided-registration-token> \
  --name gamepedia-core-us-east-1 \
  --work _work \
  --labels gamepedia-core,deploy,ec2-us-east-1
```

설명:

- `--name`: EC2 식별이 쉬운 runner 이름
- `--work _work`: runner 작업 디렉토리
- `--labels ...`: workflow `runs-on` 과 맞는 커스텀 라벨

## 5. 서비스화

configure 가 끝나면 system service 로 등록합니다.

```bash
cd ~/actions-runner/gamepedia-core-deploy
sudo ./svc.sh install "$USER"
sudo ./svc.sh start
sudo ./svc.sh status
```

권장 추가 점검:

```bash
systemctl --user status || true
sudo systemctl status actions.runner.* --no-pager
```

GitHub UI 에서 runner 상태가 `Idle` 또는 `Online` 으로 보이면 정상입니다.

## 6. 서버 준비 체크

runner 등록 전에 아래 조건이 준비되어 있어야 합니다.

- Node.js 22 이상 설치 (`package.json`의 `engine-strict` 계약과 일치해야 함)
- `npm`, `git`, `pm2` 설치
- `~/GamePediaCoreServer-prod` clone 존재
- `~/GamePediaCoreServer-staging` clone 존재
- 각 clone 에 env 파일 배치 완료
- outbound HTTPS 로 GitHub 접근 가능

## 7. Git 접근 방식

이 저장소의 deploy workflow 는 EC2 내부 clone 에서 직접 `git fetch` 를 수행합니다.

현재 저장소 origin 예시:

```bash
git -C ~/GamePediaCoreServer-prod remote -v
git -C ~/GamePediaCoreServer-staging remote -v
```

현재 repo 가 public 이면 기존 HTTPS remote 만으로 충분합니다.

private repo 면 아래 중 하나를 서버에 1회 설정합니다.

- clone 별 deploy key
- machine user PAT
- Git credential helper

중요:

- GitHub Actions secret 로 `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY` 를 둘 필요는 없습니다.
- self-hosted runner 전환 후에는 deploy traffic 이 EC2 내부에서 끝납니다.

## 8. 최초 실행 순서

runner 가 `Online` 이 된 뒤에는 아래 순서로 진행합니다.

1. staging clone 에서 `FORCE_PM2_RECREATE=1 SKIP_PRISMA_MIGRATE_DEPLOY=1 ./deploy-staging.sh`
2. staging health check 확인
3. `staging` branch 에 테스트 commit push 후 workflow 확인
4. production clone 에서 `FORCE_PM2_RECREATE=1 SKIP_PRISMA_MIGRATE_DEPLOY=1 ./deploy.sh`
5. production health check 확인
6. `main` push 로 production workflow 확인

자세한 체크리스트는 [`docs/cicd.md`](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/docs/cicd.md)를 따릅니다.

## 9. 운영 중 점검 명령

```bash
cd ~/actions-runner/gamepedia-core-deploy
sudo ./svc.sh status
```

```bash
pm2 status core-server
pm2 status core-server-staging
```

```bash
git -C ~/GamePediaCoreServer-prod rev-parse HEAD
git -C ~/GamePediaCoreServer-staging rev-parse HEAD
```

## 10. 교체 또는 제거

runner 를 교체할 때는 먼저 GitHub UI 에서 제거 token 을 발급받고 아래를 실행합니다.

```bash
cd ~/actions-runner/gamepedia-core-deploy
sudo ./svc.sh stop
./config.sh remove --token <github-provided-remove-token>
```

그 뒤 새 runner 를 다시 등록합니다.

## 11. 참고 링크

- GitHub Docs, Adding self-hosted runners:
  [https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)
- GitHub Docs, Applying labels to self-hosted runners:
  [https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/apply-labels](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/apply-labels)

위 두 문서 기준으로, 버전별 다운로드 URL 과 token 은 GitHub UI 에서 확인하는 방식이 가장 안전합니다.
