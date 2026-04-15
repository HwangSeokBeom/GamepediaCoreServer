#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <production|staging>"
  exit 1
}

if [ $# -ne 1 ]; then
  usage
fi

TARGET_ENV="$1"
SKIP_PRISMA_MIGRATE_DEPLOY="${SKIP_PRISMA_MIGRATE_DEPLOY:-0}"
FORCE_PM2_RECREATE="${FORCE_PM2_RECREATE:-0}"

case "${TARGET_ENV}" in
  production)
    BRANCH="main"
    APP_NAME="core-server"
    ENV_NAME="production"
    EXPECTED_DIR_NAME="GamePediaCoreServer-prod"
    EXPECTED_PORT="3001"
    EXPECTED_DATABASE_NAME="gamepedia_core"
    EXPECTED_PUBLIC_URL="https://gamepedia-api.duckdns.org"
    ;;
  staging)
    BRANCH="staging"
    APP_NAME="core-server-staging"
    ENV_NAME="staging"
    EXPECTED_DIR_NAME="GamePediaCoreServer-staging"
    EXPECTED_PORT="3101"
    EXPECTED_DATABASE_NAME="gamepedia_core_staging"
    EXPECTED_PUBLIC_URL="https://staging-gamepedia-api.duckdns.org"
    ;;
  *)
    usage
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CURRENT_DIR_NAME="$(basename "${PROJECT_DIR}")"
ECOSYSTEM_FILE="${PROJECT_DIR}/ecosystem.config.js"

echo "Starting ${ENV_NAME} deployment for GamePediaCoreServer"
echo "Project directory: ${PROJECT_DIR}"

cd "${PROJECT_DIR}"

if [ "${CURRENT_DIR_NAME}" != "${EXPECTED_DIR_NAME}" ]; then
  echo "Deployment aborted: ${ENV_NAME} deploy must run from ~/${EXPECTED_DIR_NAME}, current directory is ${PROJECT_DIR}"
  exit 1
fi

if [ ! -d .git ]; then
  echo "Deployment aborted: ${PROJECT_DIR} is not a git working tree"
  exit 1
fi

if [ ! -f "${ECOSYSTEM_FILE}" ]; then
  echo "Deployment aborted: missing PM2 ecosystem file ${ECOSYSTEM_FILE}"
  exit 1
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Deployment aborted: tracked files have uncommitted changes"
  exit 1
fi

echo "Fetching latest code from origin"
git fetch --prune origin

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [ "${CURRENT_BRANCH}" != "${BRANCH}" ]; then
  echo "Deployment aborted: ${PROJECT_DIR} is on branch ${CURRENT_BRANCH}, expected ${BRANCH}"
  exit 1
fi

UPSTREAM_BRANCH="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"

if [ -n "${UPSTREAM_BRANCH}" ] && [ "${UPSTREAM_BRANCH}" != "origin/${BRANCH}" ]; then
  echo "Deployment aborted: upstream branch is ${UPSTREAM_BRANCH}, expected origin/${BRANCH}"
  exit 1
fi

echo "Pulling latest ${BRANCH}"
git pull --ff-only origin "${BRANCH}"

if [ -f package-lock.json ]; then
  echo "Detected package-lock.json, installing dependencies with npm ci"
  npm ci
else
  echo "package-lock.json not found, installing dependencies with npm install"
  npm install
fi

ENV_SPECIFIC_FILE=".env.${ENV_NAME}"
ENV_SPECIFIC_LOCAL_FILE=".env.${ENV_NAME}.local"
ENV_FILES=(
  ".env"
  ".env.local"
  "${ENV_SPECIFIC_FILE}"
  "${ENV_SPECIFIC_LOCAL_FILE}"
)

FOUND_ENV_FILE=false

if [ ! -f "${ENV_SPECIFIC_FILE}" ] && [ ! -f "${ENV_SPECIFIC_LOCAL_FILE}" ]; then
  echo "Deployment aborted: missing ${ENV_SPECIFIC_FILE} or ${ENV_SPECIFIC_LOCAL_FILE}"
  exit 1
fi

set -a
for ENV_FILE in "${ENV_FILES[@]}"; do
  if [ -f "${ENV_FILE}" ]; then
    echo "Loading environment from ${ENV_FILE}"
    # shellcheck source=/dev/null
    source "${ENV_FILE}"
    FOUND_ENV_FILE=true
  fi
done
set +a

if [ "${FOUND_ENV_FILE}" = false ]; then
  echo "Deployment aborted: no env files found for ${ENV_NAME}"
  exit 1
fi

export NODE_ENV="${ENV_NAME}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "Deployment aborted: DATABASE_URL is not set after loading env files"
  exit 1
fi

if ! [[ "${DATABASE_URL}" =~ /${EXPECTED_DATABASE_NAME}([/?]|$) ]]; then
  echo "Deployment aborted: DATABASE_URL must target ${EXPECTED_DATABASE_NAME}"
  exit 1
fi

if [ -n "${PORT:-}" ] && [ "${PORT}" != "${EXPECTED_PORT}" ]; then
  echo "Deployment aborted: PORT must be ${EXPECTED_PORT} for ${ENV_NAME}, current value is ${PORT}"
  exit 1
fi

if [ -n "${API_PUBLIC_BASE_URL:-}" ] && [ "${API_PUBLIC_BASE_URL}" != "${EXPECTED_PUBLIC_URL}" ]; then
  echo "Deployment aborted: API_PUBLIC_BASE_URL must be ${EXPECTED_PUBLIC_URL}"
  exit 1
fi

if [ -n "${APP_WEB_BASE_URL:-}" ] && [ "${APP_WEB_BASE_URL}" != "${EXPECTED_PUBLIC_URL}" ]; then
  echo "Deployment aborted: APP_WEB_BASE_URL must be ${EXPECTED_PUBLIC_URL}"
  exit 1
fi

echo "Running Prisma generate"
npx prisma generate

if [ "${SKIP_PRISMA_MIGRATE_DEPLOY}" = "1" ]; then
  echo "Skipping Prisma migrate deploy because SKIP_PRISMA_MIGRATE_DEPLOY=1"
else
  echo "Running Prisma migrate deploy"
  npx prisma migrate deploy
fi

get_pm2_cwd() {
  local app_name="$1"

  pm2 jlist 2>/dev/null | node -e '
    const fs = require("fs");
    const appName = process.argv[1];
    const input = fs.readFileSync(0, "utf8").trim();

    if (!input) {
      process.exit(0);
    }

    const processList = JSON.parse(input);
    const target = processList.find((entry) => entry.name === appName);

    if (target?.pm2_env?.pm_cwd) {
      process.stdout.write(target.pm2_env.pm_cwd);
    }
  ' "${app_name}"
}

if pm2 describe "${APP_NAME}" >/dev/null 2>&1; then
  PM2_CURRENT_CWD="$(get_pm2_cwd "${APP_NAME}" || true)"

  if [ "${FORCE_PM2_RECREATE}" = "1" ]; then
    echo "Deleting PM2 process ${APP_NAME} because FORCE_PM2_RECREATE=1"
    pm2 delete "${APP_NAME}"
    echo "Starting PM2 process: ${APP_NAME}"
    pm2 start "${ECOSYSTEM_FILE}" --only "${APP_NAME}" --env "${ENV_NAME}"
  elif [ -z "${PM2_CURRENT_CWD}" ] || [ "${PM2_CURRENT_CWD}" != "${PROJECT_DIR}" ]; then
    echo "Deleting PM2 process ${APP_NAME} because current cwd is ${PM2_CURRENT_CWD:-<unknown>} and expected cwd is ${PROJECT_DIR}"
    pm2 delete "${APP_NAME}"
    echo "Starting PM2 process: ${APP_NAME}"
    pm2 start "${ECOSYSTEM_FILE}" --only "${APP_NAME}" --env "${ENV_NAME}"
  else
    echo "Restarting PM2 process: ${APP_NAME}"
    pm2 restart "${ECOSYSTEM_FILE}" --only "${APP_NAME}" --env "${ENV_NAME}" --update-env
  fi
else
  echo "Starting PM2 process: ${APP_NAME}"
  pm2 start "${ECOSYSTEM_FILE}" --only "${APP_NAME}" --env "${ENV_NAME}"
fi

echo "Saving PM2 process list"
pm2 save

echo "Deployment finished successfully"
