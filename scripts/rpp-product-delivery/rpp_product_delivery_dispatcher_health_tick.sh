#!/bin/bash
set -euo pipefail
exec env PYTHONNOUSERSITE=1 /usr/bin/python3 -s /Users/nob/Projects/rpp-8am-notify/rpp_product_delivery_dispatcher_health.py
