#!/usr/bin/env bash
# Revert to a previous commit/tag and reload. Run ON THE VPS.
#
# Usage:
#   deploy/rollback.sh                 # roll back to the most recent pre-deploy-* tag
#   deploy/rollback.sh <commit-or-tag> # roll back to a specific commit or tag
#
# Deliberately does NOT touch the database — a schema rollback (if the bad deploy included
# one) is its own manual, reviewed decision; this script only moves the running code back.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  TARGET="$(git tag --list 'pre-deploy-*' --sort=-creatordate | head -n1)"
  if [ -z "$TARGET" ]; then
    echo "No pre-deploy-* tag found and no target given. Usage: deploy/rollback.sh <commit-or-tag>" >&2
    exit 1
  fi
  echo "==> No target given — using the most recent rollback point: $TARGET"
fi

CURRENT="$(git rev-parse HEAD)"
echo "==> Rolling back from $CURRENT to $TARGET"
read -p "Confirm rollback to $TARGET? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 1
fi

git reset --hard "$TARGET"

echo "==> Installing dependencies for the rolled-back commit"
npm ci

echo "==> Building"
npm run build

echo "==> Reloading PM2"
pm2 reload deploy/ecosystem.config.cjs

echo "==> Rolled back to $TARGET"
pm2 status
