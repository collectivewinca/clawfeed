#!/bin/bash
# clawfeed-watchdog — alert on stale digest cadences.
# Pings @discoopsbot DM (chat 2134441104) via the Zeus bot if any cadence is
# older than its expected refresh window.

set -u
DB=/root/clawfeed/data/digest.db
TOKEN="${TELEGRAM_BOT_TOKEN:-}"
if [[ -z "$TOKEN" && -f /root/clawfeed/.env ]]; then
  # shellcheck disable=SC1091
  set -a; source /root/clawfeed/.env; set +a
  TOKEN="${TELEGRAM_BOT_TOKEN:-${ZEUS_BOT_TOKEN:-}}"
fi
if [[ -z "$TOKEN" ]]; then
  echo "clawfeed-watchdog: TELEGRAM_BOT_TOKEN not set" >&2
  exit 2
fi
CHAT_ID=2134441104

NOW=$(date -u +%s)
ALERTS=()

check() {
  local type="$1"
  local label="$2"
  local max_min="$3"
  local latest_iso
  latest_iso=$(sqlite3 "$DB" "SELECT created_at FROM digests WHERE type='$type' ORDER BY id DESC LIMIT 1")
  if [[ -z "$latest_iso" ]]; then
    ALERTS+=("• ${label}: NEVER produced (0 rows)")
    return
  fi
  local latest_epoch
  latest_epoch=$(date -u -d "$latest_iso UTC" +%s 2>/dev/null) || return
  local age_min=$(( (NOW - latest_epoch) / 60 ))
  if (( age_min > max_min )); then
    ALERTS+=("• ${label}: ${age_min} min stale (threshold ${max_min} min) — last ${latest_iso} UTC")
  fi
}

# 4h interval + 1h grace = 5h = 300 min
check 4h      "4h Wire"       300
# 24h + 1h grace = 25h = 1500 min
check daily   "Daily Edition" 1500
# 7d + 1d grace = 8d = 11520 min
check weekly  "Weekly Review" 11520
# 31d + 1d grace = 32d = 46080 min
check monthly "Monthly Almanac" 46080

if (( ${#ALERTS[@]} == 0 )); then
  # All healthy — silent unless verbose flag
  [[ "${1-}" == "--verbose" ]] && echo "OK: all 4 cadences within freshness windows"
  exit 0
fi

MSG="⚠ *clawfeed watchdog* — stale cadences detected:"$'\n'$'\n'
for a in "${ALERTS[@]}"; do MSG+="${a}"$'\n'; done
MSG+=$'\n'"feed.minyvinyl.com"

# Send to @discoopsbot DM via Zeus bot.
curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "text=${MSG}" \
  --data-urlencode "parse_mode=Markdown" \
  --data-urlencode "disable_web_page_preview=true" > /dev/null

# Also log locally
logger -t clawfeed-watchdog "ALERT: ${#ALERTS[@]} stale cadence(s) — ${ALERTS[*]}"
exit 1
