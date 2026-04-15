#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${PROJECT_DIR}/scripts/server/deploy-instance.sh" production
