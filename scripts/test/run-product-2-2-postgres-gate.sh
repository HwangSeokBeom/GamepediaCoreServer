#!/usr/bin/env bash
#
# Product 2.2 PostgreSQL gate.
#
# Runs two independent verifications against a disposable, locally bound
# PostgreSQL 16 container:
#
#   Phase A  fresh apply of every repository migration, then the Product 2.2
#            real-database integration tests.
#   Phase B  the legacy pre-Product-2.2 schema, seeded with legacy rows, then the
#            Product 2.2 migrations applied on top, then the backfill assertions.
#
# The gate fails closed. It never touches a production or staging database: it
# generates its own credentials and database name, refuses a name that looks
# production-like, and confirms the target with SELECT current_database() before
# running anything. If Docker is unavailable the gate exits non-zero with
# BLOCKED_WITH_REASON rather than reporting a pass.

set -euo pipefail

readonly POSTGRES_IMAGE="postgres:16-alpine"
readonly CONTAINER_PREFIX="gamepedia-product-2-2-gate"
readonly DATABASE_PREFIX="gamepedia_product_2_2"
readonly RUN_ID="$(date -u +%Y%m%d%H%M%S)-$$-$RANDOM"
readonly CONTAINER_NAME="${CONTAINER_PREFIX}-${RUN_ID}"
readonly FRESH_DATABASE="${DATABASE_PREFIX}_fresh_${RUN_ID//-/_}"
readonly UPGRADE_DATABASE="${DATABASE_PREFIX}_upgrade_${RUN_ID//-/_}"
readonly POSTGRES_USER="product_2_2_gate"
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly LEGACY_STAGE_DIR="${TMPDIR:-/tmp}/product-2-2-legacy-${RUN_ID}"

container_started=0

blocked() {
  echo "BLOCKED_WITH_REASON: $1" >&2
  exit 2
}

cleanup() {
  if [[ "$container_started" -eq 1 ]]; then
    docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi

  rm -rf "$LEGACY_STAGE_DIR" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

cd "$REPO_ROOT"

# --- preconditions -----------------------------------------------------------

command -v docker >/dev/null 2>&1 || blocked "Docker is required for the isolated PostgreSQL gate and is not installed."
command -v openssl >/dev/null 2>&1 || blocked "openssl is required to generate disposable gate credentials."
docker info >/dev/null 2>&1 || blocked "Docker is installed but not usable; the PostgreSQL gate fails closed."

# Matches whole underscore-delimited segments only, so "product" is not mistaken
# for "prod".
for database_name in "$FRESH_DATABASE" "$UPGRADE_DATABASE"; do
  if [[ "_${database_name}_" =~ _(prod|production|stage|staging|live|prd|stg)_ ]]; then
    echo "ERROR: refusing to run against a production-like database name: $database_name" >&2
    exit 1
  fi
done

# Any inherited DATABASE_URL is discarded: this gate only ever talks to the
# disposable database it creates itself.
unset DATABASE_URL || true

readonly POSTGRES_PASSWORD="$(openssl rand -hex 24)"
readonly GATE_SECRET="$(openssl rand -hex 32)"
readonly MIGRATION_COUNT="$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
readonly LEGACY_MIGRATION_COUNT="$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d ! -name '20260730*' | wc -l | tr -d ' ')"
readonly PRODUCT_MIGRATION_COUNT=$((MIGRATION_COUNT - LEGACY_MIGRATION_COUNT))

if [[ "$PRODUCT_MIGRATION_COUNT" -lt 1 ]]; then
  echo "ERROR: no Product 2.2 migrations were found." >&2
  exit 1
fi

echo "Starting isolated PostgreSQL 16 container: $CONTAINER_NAME"
docker run \
  --detach \
  --rm \
  --name "$CONTAINER_NAME" \
  --publish "127.0.0.1::5432" \
  --env "POSTGRES_DB=$FRESH_DATABASE" \
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
    --dbname "$FRESH_DATABASE" \
    --tuples-only \
    --no-align \
    --command 'SELECT current_database();' 2>/dev/null || true)"

  if [[ "$active_database" == "$FRESH_DATABASE" ]]; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "$ready" -ne 1 ]]; then
  blocked "The generated PostgreSQL database did not become queryable within 60 seconds."
fi

echo "Confirmed target database via SELECT current_database(): $active_database"

readonly FRESH_DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${published_port}/${FRESH_DATABASE}"
readonly UPGRADE_DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${published_port}/${UPGRADE_DATABASE}"

base_env=(
  "NODE_ENV=test"
  "APP_ENV=test"
  "MAIL_MODE=log"
  "JWT_ACCESS_SECRET=${GATE_SECRET}-access"
  "JWT_REFRESH_SECRET=${GATE_SECRET}-refresh"
  "ACCESS_TOKEN_EXPIRES_IN=15m"
  "REFRESH_TOKEN_EXPIRES_IN=30d"
  "BCRYPT_SALT_ROUNDS=4"
  "RUN_POSTGRES_INTEGRATION=1"
)

# ---------------------------------------------------------------------------
# Phase A: fresh apply of every migration
# ---------------------------------------------------------------------------

echo
echo "=== Phase A: fresh apply of all $MIGRATION_COUNT migrations ==="

echo "Generating the Prisma client inside the gate."
env "${base_env[@]}" "DATABASE_URL=$FRESH_DATABASE_URL" npx prisma generate

env "${base_env[@]}" "DATABASE_URL=$FRESH_DATABASE_URL" npx prisma migrate deploy

applied_migrations="$(docker exec "$CONTAINER_NAME" psql \
  --username "$POSTGRES_USER" \
  --dbname "$FRESH_DATABASE" \
  --tuples-only \
  --no-align \
  --command 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')"

if [[ "$applied_migrations" != "$MIGRATION_COUNT" ]]; then
  echo "ERROR: applied migration count ($applied_migrations) does not match the repository count ($MIGRATION_COUNT)." >&2
  exit 1
fi

echo "Confirming the schema and the migrations agree (an empty diff is required)."
diff_output="$(env "${base_env[@]}" "DATABASE_URL=$FRESH_DATABASE_URL" npx prisma migrate diff \
  --from-url "$FRESH_DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script)"

if ! grep -q 'This is an empty migration' <<<"$diff_output"; then
  echo "ERROR: prisma/schema.prisma and the applied migrations have drifted:" >&2
  echo "$diff_output" >&2
  exit 1
fi

echo "Running the Product 2.2 real-database integration tests."
env "${base_env[@]}" "DATABASE_URL=$FRESH_DATABASE_URL" node --test test/product-2-2/product-2-2.postgres.test.js

# ---------------------------------------------------------------------------
# Phase B: legacy schema, then the Product 2.2 migrations on top
# ---------------------------------------------------------------------------

echo
echo "=== Phase B: legacy schema ($LEGACY_MIGRATION_COUNT migrations) upgraded with $PRODUCT_MIGRATION_COUNT Product 2.2 migrations ==="

docker exec "$CONTAINER_NAME" psql \
  --username "$POSTGRES_USER" \
  --dbname "$FRESH_DATABASE" \
  --quiet \
  --command "CREATE DATABASE \"$UPGRADE_DATABASE\";" >/dev/null

upgrade_active_database="$(docker exec "$CONTAINER_NAME" psql \
  --username "$POSTGRES_USER" \
  --dbname "$UPGRADE_DATABASE" \
  --tuples-only \
  --no-align \
  --command 'SELECT current_database();')"

if [[ "$upgrade_active_database" != "$UPGRADE_DATABASE" ]]; then
  echo "ERROR: could not confirm the upgrade target database." >&2
  exit 1
fi

echo "Confirmed upgrade target database via SELECT current_database(): $upgrade_active_database"

# Stage the legacy-only migration set plus the baseline schema. The repository's
# own prisma/ directory is never modified.
mkdir -p "$LEGACY_STAGE_DIR/prisma/migrations"
cp prisma/migrations/migration_lock.toml "$LEGACY_STAGE_DIR/prisma/migrations/"

for migration_dir in prisma/migrations/*/; do
  migration_name="$(basename "$migration_dir")"

  case "$migration_name" in
    20260730*) continue ;;
  esac

  cp -R "$migration_dir" "$LEGACY_STAGE_DIR/prisma/migrations/$migration_name"
done

# The baseline schema is read from the merge base with origin/main so the legacy
# phase reflects the shipped schema, not the branch's schema.
baseline_ref="$(git merge-base HEAD origin/main 2>/dev/null || echo '')"

if [[ -z "$baseline_ref" ]]; then
  blocked "Could not resolve the merge base with origin/main, so the legacy baseline schema is unavailable."
fi

git show "${baseline_ref}:prisma/schema.prisma" > "$LEGACY_STAGE_DIR/prisma/schema.prisma"

echo "Applying the $LEGACY_MIGRATION_COUNT legacy migrations."
(
  cd "$LEGACY_STAGE_DIR"
  DATABASE_URL="$UPGRADE_DATABASE_URL" "$REPO_ROOT/node_modules/.bin/prisma" migrate deploy --schema prisma/schema.prisma
)

echo "Seeding pre-Product-2.2 fixture rows."
docker exec -i "$CONTAINER_NAME" psql \
  --username "$POSTGRES_USER" \
  --dbname "$UPGRADE_DATABASE" \
  --quiet \
  --set ON_ERROR_STOP=1 < scripts/test/product-2-2-legacy-fixture.sql >/dev/null

echo "Applying the Product 2.2 migrations on top of the legacy schema."
for migration_dir in prisma/migrations/20260730*/; do
  cp -R "$migration_dir" "$LEGACY_STAGE_DIR/prisma/migrations/$(basename "$migration_dir")"
done
cp prisma/schema.prisma "$LEGACY_STAGE_DIR/prisma/schema.prisma"

(
  cd "$LEGACY_STAGE_DIR"
  DATABASE_URL="$UPGRADE_DATABASE_URL" "$REPO_ROOT/node_modules/.bin/prisma" migrate deploy --schema prisma/schema.prisma
)

upgrade_applied="$(docker exec "$CONTAINER_NAME" psql \
  --username "$POSTGRES_USER" \
  --dbname "$UPGRADE_DATABASE" \
  --tuples-only \
  --no-align \
  --command 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')"

if [[ "$upgrade_applied" != "$MIGRATION_COUNT" ]]; then
  echo "ERROR: the upgraded database applied $upgrade_applied migrations, expected $MIGRATION_COUNT." >&2
  exit 1
fi

echo "Verifying the backfill, the merge policy and the uniqueness constraints."
docker exec -i "$CONTAINER_NAME" psql \
  --username "$POSTGRES_USER" \
  --dbname "$UPGRADE_DATABASE" \
  --set ON_ERROR_STOP=1 < scripts/test/verify-product-2-2-backfill.sql

echo "Re-running the migrations to confirm they are idempotent (no pending work)."
(
  cd "$LEGACY_STAGE_DIR"
  DATABASE_URL="$UPGRADE_DATABASE_URL" "$REPO_ROOT/node_modules/.bin/prisma" migrate deploy --schema prisma/schema.prisma
)

reapplied="$(docker exec "$CONTAINER_NAME" psql \
  --username "$POSTGRES_USER" \
  --dbname "$UPGRADE_DATABASE" \
  --tuples-only \
  --no-align \
  --command 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')"

if [[ "$reapplied" != "$MIGRATION_COUNT" ]]; then
  echo "ERROR: re-running migrate deploy changed the applied count ($reapplied)." >&2
  exit 1
fi

echo "Confirming the backfill assertions still hold after the idempotent re-run."
docker exec -i "$CONTAINER_NAME" psql \
  --username "$POSTGRES_USER" \
  --dbname "$UPGRADE_DATABASE" \
  --set ON_ERROR_STOP=1 < scripts/test/verify-product-2-2-backfill.sql

echo
echo "Product 2.2 PostgreSQL gate passed."
echo "  fresh database:   $FRESH_DATABASE ($applied_migrations migrations)"
echo "  upgraded database: $UPGRADE_DATABASE ($LEGACY_MIGRATION_COUNT legacy + $PRODUCT_MIGRATION_COUNT Product 2.2)"
