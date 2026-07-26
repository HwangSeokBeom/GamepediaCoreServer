# GamePedia 운영 Runbook

검증 기준일: 2026-07-26
리전: `ap-northeast-2`
EC2: `i-077d75be5c40ec487`
도메인: `https://gamepedia-api.duckdns.org`
내부 포트: `3001`
PM2 앱: `core-server`

이 문서는 새 AWS 계정의 현재 배치 구성을 운영하는 절차다. SSH 22번 포트는
열지 않는다. 집과 회사의 IP가 달라도 AWS 인증 후 SSM Session Manager로
접속한다.

## 1. 접속

로컬 터미널에서 현재 AWS 계정과 SSM 상태를 확인한다.

```bash
aws sts get-caller-identity

aws ssm describe-instance-information \
  --region ap-northeast-2 \
  --filters Key=InstanceIds,Values=i-077d75be5c40ec487

aws ssm start-session \
  --region ap-northeast-2 \
  --target i-077d75be5c40ec487
```

서버에 접속한 뒤 운영 사용자로 전환한다.

```bash
sudo -iu ec2-user
cd /home/ec2-user/GamePediaCoreServer-prod
```

SSM 접속에는 EC2 보안 그룹의 SSH 허용이나 집/회사 IP 등록이 필요하지 않다.

## 2. 매일 확인

외부에서:

```bash
curl -fsS https://gamepedia-api.duckdns.org/health | jq
```

서버에서:

```bash
sudo systemctl is-active nginx pm2-ec2-user
sudo systemctl is-enabled nginx pm2-ec2-user
sudo -u ec2-user -H pm2 status
sudo -u ec2-user -H pm2 describe core-server
curl -fsS http://127.0.0.1:3001/health | jq
```

정상 기준:

- Nginx와 `pm2-ec2-user`가 `active`, `enabled`
- `core-server`가 `online`
- localhost/public `/health`가 HTTP 200
- health의 SMTP `verified=true`
- Firebase push `enabled=true`, `initialized=true`
- Firebase project가 `gamepedia-eb58c`

## 3. 로그

```bash
sudo -u ec2-user -H pm2 logs core-server --lines 200 --nostream
sudo tail -n 200 /home/ec2-user/.pm2/logs/core-server-out.log
sudo tail -n 200 /home/ec2-user/.pm2/logs/core-server-error.log
sudo tail -n 200 /var/log/nginx/access.log
sudo tail -n 200 /var/log/nginx/error.log
sudo journalctl -u pm2-ec2-user -n 200 --no-pager
```

Firebase/메일만 좁혀 볼 때:

```bash
sudo -u ec2-user -H pm2 logs core-server --lines 400 --nostream 2>&1 \
  | grep -Ei 'FirebaseAdmin|push|mail|smtp'
```

CloudWatch Logs:

- `/project-services/gamepedia/app`
- `/project-services/gamepedia/nginx`
- 보관 기간: 14일

로그에 JWT, 비밀번호, SMTP 비밀번호, Firebase 서비스 계정 JSON 또는 전체 push
token을 출력하지 않는다.

## 4. 안전한 재시작

앱만 재시작:

```bash
sudo -u ec2-user -H bash -lc '
  cd /home/ec2-user/GamePediaCoreServer-prod
  pm2 restart core-server --update-env
  pm2 save
'

sleep 5
curl -fsS http://127.0.0.1:3001/health | jq
curl -fsS https://gamepedia-api.duckdns.org/health | jq
```

Nginx 변경 후:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl status nginx --no-pager
```

설정 검증 실패 시 재시작하거나 reload하지 않는다.

## 5. 환경설정과 비밀값

운영 파일:

- `/home/ec2-user/GamePediaCoreServer-prod/.env.production`
- 권한: `600`, 소유자: `ec2-user`

Secrets Manager:

- `production/gamepedia/database`
- `production/gamepedia/runtime`
- `production/gamepedia/review-account`

비밀값은 Git, 문서, 채팅, PM2 명령 인자에 넣지 않는다. 변경은 Secrets Manager에
먼저 적용하고, 승인된 동기화 절차로 `.env.production`을 갱신한 뒤
`pm2 restart core-server --update-env`를 수행한다. 파일 내용을 통째로 출력하지
않고 필요한 키의 존재 여부만 확인한다.

## 6. 배포

운영 서버에서 임의로 `git pull`하지 않는다.

1. clean 작업 브랜치에서 구현과 테스트를 완료한다.
2. `npm ci`, Prisma validate/generate, canonical tests, PostgreSQL gate를
   통과한다.
3. 배포할 exact commit SHA를 기록한다.
4. RDS snapshot 또는 최신 자동 백업 상태를 확인한다.
5. 새 artifact를 별도 경로에서 준비하고 환경 검증을 수행한다.
6. PM2 대상만 전환하고 localhost health를 먼저 확인한다.
7. public health와 리뷰 계정 로그인을 확인한다.
8. 실패하면 직전 artifact와 PM2 dump로 되돌린다.

운영 migration은 disposable PostgreSQL rehearsal과 snapshot 확인 후에만
`npx prisma migrate deploy`로 실행한다. `prisma db push`, 개발 seed, 운영 DB
초기화 명령은 사용하지 않는다.

## 7. 장애 대응

앱만 비정상:

```bash
sudo -u ec2-user -H pm2 status
sudo -u ec2-user -H pm2 logs core-server --lines 200 --nostream
sudo systemctl restart pm2-ec2-user
```

Nginx 502:

1. `curl http://127.0.0.1:3001/health` 확인
2. `sudo nginx -t`
3. `/var/log/nginx/error.log` 확인
4. 앱이 정상일 때만 Nginx reload

DB/Redis 의심:

- secret이나 연결 문자열을 출력하지 않는다.
- CloudWatch RDS connection/CPU/storage alarm을 확인한다.
- 운영 DB에 destructive SQL을 실행하지 않는다.
- 복구가 필요하면 snapshot 복원으로 새 DB를 만들고 검증 후 전환한다.

## 8. 알림과 인증서

SNS topic: `project-services-ops-alerts`

```bash
aws sns list-subscriptions-by-topic \
  --region ap-northeast-2 \
  --topic-arn arn:aws:sns:ap-northeast-2:486208157237:project-services-ops-alerts

sudo certbot certificates
sudo systemctl status certbot-renew.timer --no-pager
```

SNS 알림이 오면 CloudWatch alarm 이름, 발생 시각, `/health`, PM2, Nginx 로그
순으로 확인한다.
