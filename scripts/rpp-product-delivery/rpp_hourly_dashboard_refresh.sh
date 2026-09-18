#!/usr/bin/env bash
set -euo pipefail
exec /usr/bin/python3 -s /Users/nob/Projects/rpp-8am-notify/deploy_worker_runtime.py --run-dashboard-refresh hourly
