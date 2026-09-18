#!/usr/bin/env bash
set -euo pipefail
REFRESH_OUTPUT="$(mktemp /tmp/rpp-position-refresh.XXXXXX)"
RECONCILE_OUTPUT="$(mktemp /tmp/rpp-position-reconcile.XXXXXX)"
trap 'rm -f "$REFRESH_OUTPUT" "$RECONCILE_OUTPUT"' EXIT

set +e
/usr/bin/python3 -s /Users/nob/Projects/rpp-8am-notify/deploy_worker_runtime.py --run-dashboard-refresh positions >"$REFRESH_OUTPUT" 2>&1
REFRESH_STATUS=$?
/bin/bash /Users/nob/.hermes/scripts/rpp_product_delivery_scheduler_tick.sh >"$RECONCILE_OUTPUT" 2>&1
RECONCILE_STATUS=$?
set -e

for output in "$REFRESH_OUTPUT" "$RECONCILE_OUTPUT"; do
  if [[ -s "$output" ]]; then
    while IFS= read -r line; do
      printf '%s\n' "$line"
    done <"$output"
  fi
done

if [[ "$RECONCILE_STATUS" -ne 0 ]]; then
  exit "$RECONCILE_STATUS"
fi
exit "$REFRESH_STATUS"
