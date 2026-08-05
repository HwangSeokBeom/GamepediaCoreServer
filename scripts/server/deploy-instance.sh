#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <production|staging>"
  exit 1
}

require_command() {
  local command_name="$1"

  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Deployment aborted: missing required command '${command_name}'"
    exit 1
  fi
}

is_truthy() {
  case "${1,,}" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

if [ $# -ne 1 ]; then
  usage
fi

TARGET_ENV="$1"
SKIP_PRISMA_MIGRATE_DEPLOY="${SKIP_PRISMA_MIGRATE_DEPLOY:-0}"
FORCE_PM2_RECREATE="${FORCE_PM2_RECREATE:-0}"
EXPECTED_GIT_SHA="${EXPECTED_GIT_SHA:-}"

case "${TARGET_ENV}" in
  production)
    BRANCH="main"
    APP_NAME="core-server"
    ENV_NAME="production"
    APP_PORT="3001"
    EXPECTED_DIR_NAME="GamePediaCoreServer-prod"
    PM2_CWD_ENV_VAR="CORE_SERVER_PRODUCTION_CWD"
    ;;
  staging)
    BRANCH="staging"
    APP_NAME="core-server-staging"
    ENV_NAME="staging"
    APP_PORT="3101"
    EXPECTED_DIR_NAME="GamePediaCoreServer-staging"
    PM2_CWD_ENV_VAR="CORE_SERVER_STAGING_CWD"
    ;;
  *)
    usage
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
CURRENT_DIR_NAME="$(basename "${PROJECT_DIR}")"
ECOSYSTEM_FILE="${PROJECT_DIR}/ecosystem.config.js"

echo "Starting ${ENV_NAME} deployment for GamePediaCoreServer"
echo "Project directory: ${PROJECT_DIR}"

require_command git
require_command node
require_command npm
require_command npx
require_command pm2

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

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [ "${CURRENT_BRANCH}" != "${BRANCH}" ]; then
  echo "Deployment aborted: ${PROJECT_DIR} is on branch ${CURRENT_BRANCH}, expected ${BRANCH}"
  exit 1
fi

CURRENT_SHA="$(git rev-parse HEAD)"

if [ -n "${EXPECTED_GIT_SHA}" ] && [ "${CURRENT_SHA}" != "${EXPECTED_GIT_SHA}" ]; then
  echo "Deployment aborted: current commit ${CURRENT_SHA} does not match EXPECTED_GIT_SHA=${EXPECTED_GIT_SHA}"
  exit 1
fi

if [ ! -f package-lock.json ]; then
  echo "Deployment aborted: package-lock.json is required for server deployment"
  exit 1
fi

echo "Installing the runtime dependency tree with npm ci"
npm ci --omit=dev --omit=optional

echo "Validating deployment environment via dotenv loader order"
NODE_ENV="${ENV_NAME}" node "${PROJECT_DIR}/scripts/server/validate-deploy-env.js" "${TARGET_ENV}"

echo "Running Prisma generate"
NODE_ENV="${ENV_NAME}" npx prisma generate

if is_truthy "${SKIP_PRISMA_MIGRATE_DEPLOY}"; then
  echo "Skipping Prisma migrate deploy because SKIP_PRISMA_MIGRATE_DEPLOY=1"
else
  echo "Running Prisma migrate deploy"
  NODE_ENV="${ENV_NAME}" npx prisma migrate deploy
fi

echo "Reconciling the pinned catalog normalization contract"
NODE_ENV="${ENV_NAME}" npm run --silent catalog:normalization:reconcile

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

run_pm2_with_cwd() {
  env "${PM2_CWD_ENV_VAR}=${PROJECT_DIR}" pm2 "$@"
}

if pm2 describe "${APP_NAME}" >/dev/null 2>&1; then
  PM2_CURRENT_CWD="$(get_pm2_cwd "${APP_NAME}" || true)"

  if is_truthy "${FORCE_PM2_RECREATE}"; then
    echo "Deleting PM2 process ${APP_NAME} because FORCE_PM2_RECREATE=1"
    pm2 delete "${APP_NAME}"
    echo "Starting PM2 process: ${APP_NAME}"
    run_pm2_with_cwd start "${ECOSYSTEM_FILE}" --only "${APP_NAME}" --env "${ENV_NAME}"
  elif [ -z "${PM2_CURRENT_CWD}" ] || [ "${PM2_CURRENT_CWD}" != "${PROJECT_DIR}" ]; then
    echo "Deleting PM2 process ${APP_NAME} because current cwd is ${PM2_CURRENT_CWD:-<unknown>} and expected cwd is ${PROJECT_DIR}"
    pm2 delete "${APP_NAME}"
    echo "Starting PM2 process: ${APP_NAME}"
    run_pm2_with_cwd start "${ECOSYSTEM_FILE}" --only "${APP_NAME}" --env "${ENV_NAME}"
  else
    echo "Restarting PM2 process: ${APP_NAME}"
    run_pm2_with_cwd restart "${ECOSYSTEM_FILE}" --only "${APP_NAME}" --env "${ENV_NAME}" --update-env
  fi
else
  echo "Starting PM2 process: ${APP_NAME}"
  run_pm2_with_cwd start "${ECOSYSTEM_FILE}" --only "${APP_NAME}" --env "${ENV_NAME}"
fi

PM2_FINAL_CWD="$(get_pm2_cwd "${APP_NAME}" || true)"

if [ "${PM2_FINAL_CWD}" != "${PROJECT_DIR}" ]; then
  echo "Deployment aborted: PM2 cwd for ${APP_NAME} is ${PM2_FINAL_CWD:-<unknown>}, expected ${PROJECT_DIR}"
  exit 1
fi

echo "Verifying application and IGDB readiness through localhost"
NODE_ENV="${ENV_NAME}" node "${PROJECT_DIR}/scripts/server/verify-runtime-readiness.js" \
  --base-url "http://127.0.0.1:${APP_PORT}" \
  --attempts 10 \
  --interval-ms 1000

echo "Saving PM2 process list"
pm2 save

echo "Deployment finished successfully"
