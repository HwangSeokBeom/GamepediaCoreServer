#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() {
  printf '\n[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1"
}

log "Starting deployment for GamePediaCoreServer"
log "Project directory: ${PROJECT_DIR}"

cd "${PROJECT_DIR}"

if [[ -n "$(git status --porcelain)" ]]; then
  log "Deployment aborted: working tree is not clean"
  exit 1
fi

log "Fetching latest code from origin"
git fetch --prune origin

log "Checking out main"
git checkout main

log "Pulling latest main"
git pull --ff-only origin main

if [[ -f package-lock.json ]]; then
  log "Installing dependencies with npm ci"
  npm ci
else
  log "Installing dependencies with npm install"
  npm install
fi

if [[ -f prisma/schema.prisma ]]; then
  log "Running Prisma generate"
  npx prisma generate

  log "Running Prisma db push"
  npx prisma db push
fi

if pm2 describe core-server >/dev/null 2>&1; then
  log "Restarting PM2 process: core-server"
  pm2 restart ecosystem.config.js --only core-server --env production
else
  log "Starting PM2 process: core-server"
  pm2 start ecosystem.config.js --only core-server --env production
fi

log "Saving PM2 process list"
pm2 save

log "Deployment finished successfully"
