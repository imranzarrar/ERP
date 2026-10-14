#!/usr/bin/env bash
# Sets ONE password you choose for every user in the DEMO database (erp_demo). The password is typed at a hidden prompt and is never
# printed or stored; only its bcrypt hash goes into the demo database. It refuses to run against anything that is not a demo database.
#
#   as root on the VPS:   su - warraq-demo -c "cd ~/apps/erp-demo && bash deploy/set-demo-password.sh"
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "ERROR: $*" >&2; exit 1; }
read_secret() {
  local raw; raw="$(grep -E "^$1=" app.secrets | head -n1 | cut -d= -f2- || true)"; raw="${raw%$'\r'}"
  if [[ "$raw" == \"*\" && "$raw" == *\" ]] || [[ "$raw" == \'*\' && "$raw" == *\' ]]; then raw="${raw:1:-1}"; fi
  printf '%s' "$raw"
}
[ -f app.secrets ] || die "Run from the demo checkout (app.secrets not found)."
DB="$(read_secret SQL_DB_NAME)"
case "$DB" in erp_demo*|erp_v2*) ;; *) die "Database '$DB' is not a demo database. Refusing." ;; esac
[ "$(read_secret APP_ENV)" = "demo" ] || [[ "$DB" == erp_v2* ]] || die "app.secrets does not say APP_ENV=demo."

read -r -s -p "New demo password for every user (min 8 characters): " PW; echo
read -r -s -p "Repeat: " PW2; echo
[ "$PW" = "$PW2" ] || die "The two entries differ."
[ "${#PW}" -ge 8 ] || die "Too short."
HASH="$(DEMO_PASSWORD="$PW" node -e "process.stdout.write(require('bcrypt').hashSync(process.env.DEMO_PASSWORD, 10))")"
unset PW PW2
# (psql only substitutes :'h' in text read from a file or stdin, not in -c strings)
N="$(printf "UPDATE users SET password = :'h', must_change_password = false RETURNING 1;
" | PGPASSWORD="$(read_secret SQL_PASSWORD)" psql -h "$(read_secret SQL_HOST)" -U "$(read_secret SQL_USER)" -d "$DB" -At -v ON_ERROR_STOP=1 -v "h=$HASH" -f - | grep -c '^1$' || true)"
echo "Password updated for $N user(s) in $DB."
rm -f "$HOME/.demo-password"
echo "The old generated password file was removed."
