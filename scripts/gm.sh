#!/usr/bin/env bash
# Compare the current code against the FID golden master on the LOCAL restored copy.
# Usage: scripts/gm.sh [save|compare]   (default compare)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
B="${TEST_DATABASE_URL%/fid_trading_test*}"
G="${B}/fid_golden?schema=public"
case "$G" in *127.0.0.1*fid_golden*) ;; *) echo "REFUSING: golden DB must be the local copy"; exit 1;; esac
DATABASE_URL="$G" DIRECT_URL="$G" DATABASE_POOL_MAX=2 npx tsx --tsconfig tsconfig.json scripts/golden-master.ts "${1:-compare}" backups/golden-master-fid-2026-09-29.json
