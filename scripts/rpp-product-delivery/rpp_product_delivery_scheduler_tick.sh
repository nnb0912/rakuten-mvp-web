#!/usr/bin/env bash
# Reconcile RPP product delivery schedules every minute.
set -euo pipefail
export HOME="/Users/nob"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export RPP_ENABLE_PRODUCT_DELIVERY_SCHEDULER=1
export RPP_PROJECT_DIR="/Users/nob/Projects/rpp-8am-notify"
export RPP_RUNTIME_DIR="/Users/nob/Projects/rakuten-mvp-web-runtime"
export RAKUTEN_MVP_WEB_DIR="$RPP_RUNTIME_DIR"
export RPP_SETTINGS_REFRESH_SCRIPT="$RPP_RUNTIME_DIR/scripts/rpp-product-delivery/scripts_refresh_rpp_settings_csvs.py"
TMP="$(mktemp /tmp/rpp-product-delivery-scheduler.XXXXXX)"
trap 'rm -f "$TMP"' EXIT
set +e
/usr/bin/python3 "$RPP_RUNTIME_DIR/scripts/rpp-product-delivery/rpp_product_delivery_scheduler.py" \
  --execute \
  --confirm=RPP_PRODUCT_DELIVERY_SCHEDULER >"$TMP" 2>&1
STATUS=$?
set -e
if [[ -s "$TMP" ]]; then
  while IFS= read -r line; do
    printf '%s\n' "$line"
  done <"$TMP"
fi
exit "$STATUS"
