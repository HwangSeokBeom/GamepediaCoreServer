#!/usr/bin/env bash

set -euo pipefail

readonly POSTGRES_IMAGE="postgres:16-alpine"
readonly CONTAINER_PREFIX="gamepedia-auth-contract"
readonly DATABASE_PREFIX="gamepedia_auth_contract"
readonly RUN_ID="$(date -u +%Y%m%d%H%M%S)-$$-$RANDOM"
readonly CONTAINER_NAME="${CONTAINER_PREFIX}-${RUN_ID}"
readonly DATABASE_NAME="${DATABASE_PREFIX}_${RUN_ID//-/_}"
readonly POSTGRES_USER="gamepedia_gate"
readonly MIGRATION_COUNT="$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"

container_started=0

cleanup() {
  if [[ "$container_started" -eq 1 ]]; then
    docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is required for the isolated PostgreSQL gate." >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "ERROR: openssl is required to generate disposable gate credentials." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker is unavailable; the PostgreSQL gate fails closed." >&2
  exit 1
fi

readonly POSTGRES_PASSWORD="$(openssl rand -hex 24)"
readonly GATE_SECRET="$(openssl rand -hex 32)"

echo "Starting isolated PostgreSQL 16 container: $CONTAINER_NAME"
docker run \
  --detach \
  --rm \
  --name "$CONTAINER_NAME" \
  --publish "127.0.0.1::5432" \
  --env "POSTGRES_DB=$DATABASE_NAME" \
  --env "POSTGRES_USER=$POSTGRES_USER" \
  --env "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" \
  "$POSTGRES_IMAGE" >/dev/null
container_started=1

published_address="$(docker port "$CONTAINER_NAME" 5432/tcp)"
published_port="${published_address##*:}"

if [[ ! "$published_address" =~ ^127\.0\.0\.1:[0-9]+$ ]] || [[ ! "$published_port" =~ ^[0-9]+$ ]]; then
  echo "ERROR: PostgreSQL was not bound to a valid 127.0.0.1 port." >&2
  exit 1
fi

ready=0
active_database=""
for _ in $(seq 1 60); do
  active_database="$(docker exec "$CONTAINER_NAME" psql \
    --username "$POSTGRES_USER" \
    --dbname "$DATABASE_NAME" \
    --tuples-only \
    --no-align \
    --command 'SELECT current_database();' 2>/dev/null || true)"

  if [[ "$active_database" == "$DATABASE_NAME" ]]; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "$ready" -ne 1 ]]; then
  echo "ERROR: Generated PostgreSQL database did not become queryable within 60 seconds." >&2
  exit 1
fi

readonly GATE_DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${published_port}/${DATABASE_NAME}"
readonly TEST_ENV=(
  "NODE_ENV=test"
  "APP_ENV=test"
  "DATABASE_URL=$GATE_DATABASE_URL"
  "JWT_ACCESS_SECRET=${GATE_SECRET}-access"
  "JWT_REFRESH_SECRET=${GATE_SECRET}-refresh"
  "ACCESS_TOKEN_EXPIRES_IN=15m"
  "REFRESH_TOKEN_EXPIRES_IN=30d"
  "BCRYPT_SALT_ROUNDS=4"
  "MAIL_MODE=log"
  "RUN_POSTGRES_INTEGRATION=1"
)

unset DATABASE_URL

echo "Generating the Prisma client for the isolated gate."
env "${TEST_ENV[@]}" npx prisma generate

echo "Applying all $MIGRATION_COUNT repository migrations."
env "${TEST_ENV[@]}" npx prisma migrate deploy

applied_migrations="$(docker exec "$CONTAINER_NAME" psql \
  --username "$POSTGRES_USER" \
  --dbname "$DATABASE_NAME" \
  --tuples-only \
  --no-align \
  --command 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')"

if [[ "$applied_migrations" != "$MIGRATION_COUNT" ]]; then
  echo "ERROR: Applied migration count does not match the repository migration count." >&2
  exit 1
fi

echo "Running PostgreSQL auth, signup, and push-token contract tests."
env "${TEST_ENV[@]}" node --test \
  test/auth-refresh-postgres.integration.test.js \
  test/auth-signup-postgres.integration.test.js \
  test/push-token-postgres.integration.test.js

echo "PostgreSQL gate passed with $applied_migrations migrations on the isolated database."
