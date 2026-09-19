#!/usr/bin/env bash
# Idempotent Nginx performance setup for this app: HTTP/2, response compression, long-lived caching
# of the hashed /assets/ files. Run ON THE VPS as the deploy user (uses sudo), from the repo root,
# AFTER the site's server block exists (deploy/nginx.erp.conf.template) and Certbot has added SSL.
# Safe to re-run: every step checks before changing anything, and nothing is reloaded unless
# `nginx -t` passes.
#
#   bash deploy/nginx-tuning.sh your.domain.example
#
# What each part fixes (all measured on the real deployment, see docs/deployment-plan.md Part 3):
#   HTTP/2      browsers over HTTP/1.1 fetch only ~6 files at a time; on a high-latency link a burst
#               of requests queued for seconds and blocked the ones that mattered.
#   gzip        JS/CSS/JSON were sent uncompressed (2.1 MB bundle, 1.8 MB /api/state).
#   /assets/    hashed build files get "immutable, 1 year" so repeat visits download nothing.
set -euo pipefail

DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || { echo "Usage: bash deploy/nginx-tuning.sh <domain>"; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE="$(grep -lE "server_name[[:space:]]+$DOMAIN" /etc/nginx/sites-enabled/* 2>/dev/null | head -1 || true)"
[ -n "$SITE" ] || { echo "No file in /etc/nginx/sites-enabled/ has server_name $DOMAIN"; exit 1; }
echo "==> Site config: $SITE"
BACKUP="/root/nginx-site.bak-$(date +%Y%m%d-%H%M%S)"
sudo cp "$SITE" "$BACKUP" && echo "==> Backed up to $BACKUP"

# 1. asset caching snippet + include
sudo mkdir -p /etc/nginx/snippets
sudo install -m 644 "$HERE/nginx-snippets/erp-assets.conf" /etc/nginx/snippets/erp-assets.conf
if sudo grep -q "erp-assets.conf" "$SITE"; then
  echo "==> assets include already present"
else
  sudo sed -i --follow-symlinks '0,/^[[:space:]]*location \/ {/s//    include snippets\/erp-assets.conf;\n\n    location \/ {/' "$SITE"
  echo "==> added include snippets/erp-assets.conf"
fi

# 2. compression (skip if the main nginx.conf already configures gzip_types)
if sudo nginx -T 2>/dev/null | grep -Eq '^[[:space:]]*gzip_types'; then
  echo "==> gzip_types already active in nginx config — leaving compression as is"
else
  TMP="$(mktemp)"
  if ! sudo nginx -T 2>/dev/null | grep -Eq '^[[:space:]]*gzip on;'; then echo "gzip on;" > "$TMP"; fi
  cat "$HERE/nginx-snippets/erp-gzip.conf" >> "$TMP"
  sudo install -m 644 "$TMP" /etc/nginx/conf.d/erp-gzip.conf && rm -f "$TMP"
  echo "==> installed /etc/nginx/conf.d/erp-gzip.conf"
fi

# 3. HTTP/2 on the SSL listeners (Certbot writes them without it). Old syntax on purpose: it works on
#    every nginx version (newer ones only warn that it is deprecated in favour of `http2 on;`).
sudo sed -i --follow-symlinks -E 's/^([[:space:]]*listen (\[::\]:)?443 ssl)( http2)?( ipv6only=on)?;/\1 http2\4;/' "$SITE"
echo "==> 443 listeners:"; sudo grep -nE "listen.*443" "$SITE"

# 4. validate, then reload — restore the backup if the test fails
if sudo nginx -t; then
  sudo systemctl reload nginx
  echo "==> nginx reloaded"
else
  echo "!! nginx -t failed — restoring $BACKUP"
  sudo cp "$BACKUP" "$SITE"
  exit 1
fi

echo ""
echo "==> Verify (want: HTTP/2 200, content-encoding: gzip, cache-control ... immutable):"
echo "    curl -sI -H 'Accept-Encoding: gzip' https://$DOMAIN/assets/\$(curl -s https://$DOMAIN/ | grep -o 'index-[^\"]*\.js' | head -1) | grep -iE '^(HTTP|content-encoding|cache-control)'"
