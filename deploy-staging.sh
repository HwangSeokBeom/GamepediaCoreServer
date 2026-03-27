#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRANCH="staging"
APP_NAME="core-server-staging"
ENV_NAME="staging"
ENV_FILE=".env.staging"

echo "Starting ${ENV_NAME} deployment for GamePediaCoreServer"
echo "Project directory: ${PROJECT_DIR}"

cd "${PROJECT_DIR}"

if [ -n "$(git status --porcelain)" ]; then
  echo "Deployment aborted: working tree is not clean"
  exit 1
fi

echo "Fetching latest code from origin"
git fetch origin

echo "Checking out ${BRANCH}"
git checkout "${BRANCH}"

echo "Pulling latest ${BRANCH}"
git pull --ff-only origin "${BRANCH}"

if [ -f package-lock.json ]; then
  echo "Installing dependencies with npm ci"
  npm ci
else
  echo "Installing dependencies with npm install"
  npm install
fi

if [ ! -f "${ENV_FILE}" ]; then
  echo "Deployment aborted: missing env file ${ENV_FILE}"
  exit 1
fi

echo "Loading environment from ${ENV_FILE}"
set -a
source "${ENV_FILE}"
set +a
export NODE_ENV="${ENV_NAME}"

echo "Running Prisma generate"
npx prisma generate

echo "Running Prisma migrate deploy"
npx prisma migrate deploy

if pm2 describe "${APP_NAME}" >/dev/null 2>&1; then
  echo "Restarting PM2 process: ${APP_NAME}"
  pm2 restart ecosystem.config.js --only "${APP_NAME}" --env "${ENV_NAME}"
else
  echo "Starting PM2 process: ${APP_NAME}"
  pm2 start ecosystem.config.js --only "${APP_NAME}" --env "${ENV_NAME}"
fi

echo "Saving PM2 process list"
pm2 save

echo "Deployment finished successfully"
