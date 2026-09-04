#!/usr/bin/env bash
# The repeatable "promote to live" script — run this ON THE VPS (as the deploy user) after
# pushing to the git remote. Pulls the latest commit, installs deps, builds, and reloads PM2
# with zero downtime (cluster reload — one instance restarts while the other keeps serving).
#
# Deliberately does NOT run db:push automatically — a schema change is always its own
# separate, manually reviewed step (see docs/deployment-plan.md's guardrails). If this
# deploy includes a schema change, run 'npm run db:push' yourself, before or after this
# script, and read its printed plan first.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

BEFORE_COMMIT="$(git rev-parse HEAD)"
echo "==> Current commit: $BEFORE_COMMIT"

echo "==> Tagging this state as a rollback point"
git tag -f "pre-deploy-$(date +%Y%m%d-%H%M%S)" "$BEFORE_COMMIT" >/dev/null

echo "==> Fetching and fast-forwarding to the latest commit on this branch"
git fetch origin
git merge --ff-only "@{upstream}"

AFTER_COMMIT="$(git rev-parse HEAD)"
if [ "$BEFORE_COMMIT" = "$AFTER_COMMIT" ]; then
  echo "==> Already up to date ($AFTER_COMMIT) — nothing to deploy."
  exit 0
fi
echo "==> Now at: $AFTER_COMMIT"

echo "==> Installing dependencies (npm ci)"
npm ci

echo "==> Building"
npm run build

SCHEMA_CHANGED="$(git diff --name-only "$BEFORE_COMMIT" "$AFTER_COMMIT" -- src/db/schema.ts)"
if [ -n "$SCHEMA_CHANGED" ]; then
  echo ""
  echo "!! src/db/schema.ts changed in this deploy ($BEFORE_COMMIT..$AFTER_COMMIT)."
  echo "!! Run 'npm run db:push' yourself and review its plan before or after this reload —"
  echo "!! it is never run automatically by this script."
  echo ""
fi

echo "==> Reloading PM2 (zero-downtime cluster reload)"
pm2 reload deploy/ecosystem.config.cjs

echo "==> Deployed $BEFORE_COMMIT -> $AFTER_COMMIT"
pm2 status
