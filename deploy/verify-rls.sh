#!/usr/bin/env bash
# Read-only post-deploy RLS check. Run ON THE VPS as the deploy user from the repo root.
# Fails (non-zero) if any public table lacks RLS, any policy has no predicate, or the tenant
# role is a superuser / bypasses RLS / can't log in.
set -euo pipefail
sec() { grep -E "^$1=" app.secrets | head -1 | cut -d= -f2- | tr -d '\r"'"'"''; }
export PGPASSWORD="$(sec SQL_PASSWORD)"
Q() { psql -h "$(sec SQL_HOST)" -U "$(sec SQL_USER)" -d "$(sec SQL_DB_NAME)" -At -c "$1"; }

NORLS="$(Q "select count(*) from pg_class where relkind='r' and relnamespace='public'::regnamespace and not relrowsecurity")"
NOPRED="$(Q "select count(*) from pg_policy where polqual is null and polwithcheck is null")"
NOQUAL="$(Q "select count(*) from pg_policy where polqual is null")"
ROLE="$(Q "select rolsuper::text||','||rolbypassrls::text||','||rolcanlogin::text from pg_roles where rolname='erp_app_tenant'")"
echo "tables without RLS ........ $NORLS (want 0)"
echo "policies without USING .... $NOQUAL (want 0)"
echo "policies with no predicate  $NOPRED (want 0)"
echo "tenant role super,bypass,login: ${ROLE:-MISSING} (want false,false,true)"
[ "$NORLS" = "0" ] && [ "$NOQUAL" = "0" ] && [ "$NOPRED" = "0" ] && [ "$ROLE" = "false,false,true" ] && echo "RLS OK" || { echo "RLS CHECK FAILED"; exit 1; }
