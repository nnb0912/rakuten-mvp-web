#!/usr/bin/env bash
set -euo pipefail
export RPP_PROJECT_DIR="/Users/nob/Projects/rpp-8am-notify"
exec /usr/bin/python3 /Users/nob/Projects/rpp-8am-notify/deploy_worker_runtime.py --run-auto-apply
