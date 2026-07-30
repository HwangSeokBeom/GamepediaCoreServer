#!/usr/bin/env bash
#
# Product 2.2 development-seed PostgreSQL gate.
#
# Applies every repository migration to a disposable PostgreSQL 16 database,
# executes the documented seed command twice in succession, and requires the
# complete fixture snapshot to be byte-identical after both runs.

set -euo pipefail

readonly POSTGRES_IMAGE="postgres:16-alpine"
readonly CONTAINER_PREFIX="gamepedia-product-2-2-seed-gate"
readonly DATABASE_PREFIX="gamepedia_product_2_2_seed"
readonly RUN_ID="$(date -u +%Y%m%d%H%M%S)-$$-$RANDOM"
readonly CONTAINER_NAME="${CONTAINER_PREFIX}-${RUN_ID}"
readonly DATABASE_NAME="${DATABASE_PREFIX}_${RUN_ID//-/_}"
readonly POSTGRES_USER="product_2_2_seed_gate"
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly MIGRATION_COUNT="$(find "$REPO_ROOT/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"

container_started=0

blocked() {
  echo "BLOCKED_WITH_REASON: $1" >&2
  exit 2
}

cleanup() {
  if [[ "$container_started" -eq 1 ]]; then
    docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

cd "$REPO_ROOT"

command -v docker >/dev/null 2>&1 || blocked "Docker is required for the isolated seed gate and is not installed."
command -v openssl >/dev/null 2>&1 || blocked "openssl is required to generate disposable gate credentials."
docker info >/dev/null 2>&1 || blocked "Docker is installed but not usable; the seed gate fails closed."

if [[ "_${DATABASE_NAME}_" =~ _(prod|production|stage|staging|live|prd|stg)_ ]]; then
  echo "ERROR: refusing to run against a production-like database name: $DATABASE_NAME" >&2
  exit 1
fi

unset DATABASE_URL || true

readonly POSTGRES_PASSWORD="$(openssl rand -hex 24)"
readonly GATE_SECRET="$(openssl rand -hex 32)"

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
  blocked "The generated PostgreSQL seed database did not become queryable within 60 seconds."
fi

readonly GATE_DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${published_port}/${DATABASE_NAME}"
readonly TEST_ENV=(
  "NODE_ENV=test"
  "APP_ENV=test"
  "MAIL_MODE=log"
  "DATABASE_URL=$GATE_DATABASE_URL"
  "JWT_ACCESS_SECRET=${GATE_SECRET}-access"
  "JWT_REFRESH_SECRET=${GATE_SECRET}-refresh"
  "ACCESS_TOKEN_EXPIRES_IN=15m"
  "REFRESH_TOKEN_EXPIRES_IN=30d"
  "BCRYPT_SALT_ROUNDS=4"
)

echo "Confirmed isolated seed target via SELECT current_database(): $active_database"
echo "Generating Prisma client and applying all $MIGRATION_COUNT migrations."
env "${TEST_ENV[@]}" npx prisma generate
env "${TEST_ENV[@]}" npx prisma migrate deploy
env "${TEST_ENV[@]}" npm run --silent catalog:normalization:reconcile

applied_migrations="$(docker exec "$CONTAINER_NAME" psql \
  --username "$POSTGRES_USER" \
  --dbname "$DATABASE_NAME" \
  --tuples-only \
  --no-align \
  --command 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')"

if [[ "$applied_migrations" != "$MIGRATION_COUNT" ]]; then
  echo "ERROR: applied migration count ($applied_migrations) does not match repository count ($MIGRATION_COUNT)." >&2
  exit 1
fi

echo "Running the documented Product 2.2 development seed command (first pass)."
first_output="$(env "${TEST_ENV[@]}" npm run --silent seed:product-2-2:dev)"
echo "$first_output"

grep -q 'catalog games created: 3' <<<"$first_output" || {
  echo "ERROR: the first seed pass did not create exactly three fixture games." >&2
  exit 1
}
grep -q 'catalog games updated: 0' <<<"$first_output" || {
  echo "ERROR: the first seed pass unexpectedly updated an existing fixture game." >&2
  exit 1
}

first_snapshot="$(env "${TEST_ENV[@]}" node scripts/test/verify-product-2-2-dev-seed.js)"

echo "Running the documented Product 2.2 development seed command (second consecutive pass)."
second_output="$(env "${TEST_ENV[@]}" npm run --silent seed:product-2-2:dev)"
echo "$second_output"

grep -q 'catalog games created: 0' <<<"$second_output" || {
  echo "ERROR: the second seed pass created a duplicate fixture game." >&2
  exit 1
}
grep -q 'catalog games updated: 3' <<<"$second_output" || {
  echo "ERROR: the second seed pass did not reuse all three fixture games." >&2
  exit 1
}

second_snapshot="$(env "${TEST_ENV[@]}" node scripts/test/verify-product-2-2-dev-seed.js)"

if [[ "$first_snapshot" != "$second_snapshot" ]]; then
  echo "ERROR: the fixture snapshot changed after the second seed pass." >&2
  exit 1
fi

echo "Product 2.2 seed-twice PostgreSQL gate passed."
echo "  migrations: $applied_migrations"
echo "  fixture games: 3"
echo "  unverified identity claims: 4"
echo "  verified fixture identities: 0"
echo "  fixture article revisions: 1 (currentRevisionId linked)"
