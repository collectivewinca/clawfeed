#!/usr/bin/env bash
# REAL SEND — fires emails to every active subscriber. Manual trigger only.
set -euo pipefail
set -a
source /root/sliver/.env
# Read email keys from clawfeed/.env without sourcing (EMAIL_FROM has '<').
if [ -f /root/clawfeed/.env ]; then
  eval "$(grep -E '^(CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_EMAIL_TOKEN|PUBLIC_BASE_URL)=' /root/clawfeed/.env | sed 's/^/export /')"
  EMAIL_FROM="$(grep -E '^EMAIL_FROM=' /root/clawfeed/.env | cut -d= -f2-)"
  EMAIL_REPLY_TO="$(grep -E '^EMAIL_REPLY_TO=' /root/clawfeed/.env | cut -d= -f2-)"
  export EMAIL_FROM EMAIL_REPLY_TO
fi
set +a
exec /root/sliver/venv/bin/python /root/clawfeed/agents/newsletter.py --send
