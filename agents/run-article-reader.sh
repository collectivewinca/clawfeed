#!/usr/bin/env bash
set -euo pipefail
cd /root/clawfeed
set -a
source /root/sliver/.env
set +a
exec /root/sliver/venv/bin/python /root/clawfeed/agents/article_reader.py
