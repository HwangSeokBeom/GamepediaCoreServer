#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REMOTE_URL="${1:-$(git -C "${SOURCE_DIR}" remote get-url origin 2>/dev/null || true)}"
PRODUCTION_DIR="${CORE_SERVER_PRODUCTION_CWD:-${HOME}/GamePediaCoreServer-prod}"
STAGING_DIR="${CORE_SERVER_STAGING_CWD:-${HOME}/GamePediaCoreServer-staging}"

if [ -z "${REMOTE_URL}" ]; then
  echo "Bootstrap aborted: could not determine git remote. Pass the repository URL as the first argument."
  exit 1
fi

bootstrap_clone() {
  local branch="$1"
  local target_dir="$2"

  if [ -e "${target_dir}" ] && [ ! -d "${target_dir}/.git" ]; then
    echo "Bootstrap aborted: ${target_dir} exists but is not a git working tree"
    exit 1
  fi

  if [ -d "${target_dir}/.git" ]; then
    if [ -n "$(git -C "${target_dir}" status --porcelain --untracked-files=no)" ]; then
      echo "Bootstrap aborted: ${target_dir} has tracked files with uncommitted changes"
      exit 1
    fi

    echo "Updating existing clone: ${target_dir} (${branch})"
    git -C "${target_dir}" fetch --prune origin "+refs/heads/${branch}:refs/remotes/origin/${branch}"
    git -C "${target_dir}" checkout "${branch}"
    git -C "${target_dir}" reset --hard "origin/${branch}"
    return
  fi

  echo "Cloning ${branch} into ${target_dir}"
  git clone --branch "${branch}" --single-branch "${REMOTE_URL}" "${target_dir}"
}

bootstrap_clone main "${PRODUCTION_DIR}"
bootstrap_clone staging "${STAGING_DIR}"

echo
echo "Clone bootstrap completed."
echo "Next steps:"
echo "  1. Verify ${PRODUCTION_DIR}/.env.production and ${PRODUCTION_DIR}/.env.production.local"
echo "  2. Verify ${STAGING_DIR}/.env.staging and ${STAGING_DIR}/.env.staging.local"
echo "  3. Re-register PM2 with FORCE_PM2_RECREATE=1 from each clone so pm_cwd matches the new path"
echo "  4. Follow docs/runner-setup.md to install and register the EC2 self-hosted runner"
