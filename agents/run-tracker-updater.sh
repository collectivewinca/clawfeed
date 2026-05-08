#!/usr/bin/env bash
set -euo pipefail
set -a
source /root/sliver/.env
set +a
exec /root/sliver/venv/bin/python /root/clawfeed/agents/tracker_updater.py
