#!/usr/bin/env bash
# One-time (idempotent) provisioning of the restricted Postgres role that Row-Level Security
# applies to. Run ON THE VPS as the deploy user (needs sudo for `sudo -u postgres`), from the
# repo root, BEFORE the first deploy that contains the RLS work.
#
#   1. creates role erp_app_tenant (LOGIN, NOSUPERUSER, NOBYPASSRLS) — its password is typed
#      at a hidden prompt and never stored by this script; put the same value in app.secrets
#      as TENANT_DB_PASSWORD (and TENANT_DB_USER=erp_app_tenant) by hand.
#   2. grants it CONNECT + SELECT/INSERT/UPDATE/DELETE on every table in schema public, plus
#      default privileges so tables created by later `db:push` runs are covered too.
#
# It does NOT create policies: run `npm run db:push` (review its plan) and then
# `npx tsx scripts/apply-rls-policies.mjs` — db:push drops the policy predicates, so the
# second step is mandatory. deploy/verify-rls.sh checks the result.
set -euo pipefail

if [ ! -f app.secrets ]; then echo "Run from the repo root (app.secrets not found)."; exit 1; fi
DB_NAME="$(grep -E '^SQL_DB_NAME=' app.secrets | head -1 | cut -d= -f2- | tr -d '\r"'"'"'')"
OWNER_ROLE="$(grep -E '^SQL_USER=' app.secrets | head -1 | cut -d= -f2- | tr -d '\r"'"'"'')"
[ -n "$DB_NAME" ] && [ -n "$OWNER_ROLE" ] || { echo "Could not read SQL_DB_NAME / SQL_USER from app.secrets"; exit 1; }

read -r -s -p "Password for new role erp_app_tenant: " TENANT_PW; echo
read -r -s -p "Repeat: " TENANT_PW2; echo
[ "$TENANT_PW" = "$TENANT_PW2" ] && [ -n "$TENANT_PW" ] || { echo "Passwords empty or different."; exit 1; }

echo "==> Creating/updating role and grants in database $DB_NAME (owner role: $OWNER_ROLE)"
sudo -u postgres psql -v ON_ERROR_STOP=1 -v pw="$TENANT_PW" -v db="$DB_NAME" -v owner="$OWNER_ROLE" -d "$DB_NAME" <<'SQL'
SELECT format('CREATE ROLE erp_app_tenant LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', :'pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app_tenant') \gexec
SELECT format('ALTER ROLE erp_app_tenant LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', :'pw') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO erp_app_tenant', :'db') \gexec
GRANT USAGE ON SCHEMA public TO erp_app_tenant;
-- Lets the app's own (non-superuser) DB user SET ROLE erp_app_tenant, which scripts/verify-tenant-isolation.ts needs.
-- Adds no access: that user already owns every table.
SELECT format('GRANT erp_app_tenant TO %I', :'owner') gexec
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO erp_app_tenant;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO erp_app_tenant;
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app_tenant', :'owner') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO erp_app_tenant', :'owner') \gexec
SQL
unset TENANT_PW TENANT_PW2

echo ""
echo "==> Done. Now, by hand, add to app.secrets:"
echo "      TENANT_DB_USER=erp_app_tenant"
echo "      TENANT_DB_PASSWORD=<the password you just typed>"
echo "    then: npm run db:push (read the plan) -> npx tsx scripts/apply-rls-policies.mjs -> deploy/verify-rls.sh"
