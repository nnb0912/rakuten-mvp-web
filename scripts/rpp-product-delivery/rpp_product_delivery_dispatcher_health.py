#!/usr/bin/env python3
"""Silent health check for the RPP delivery dispatcher."""
from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from deploy_worker_runtime import validate_loaded_dispatcher

UTC = dt.timezone.utc
HEARTBEAT = Path("/Users/nob/Projects/rpp-8am-notify/rpp_apply_logs/rpp_product_delivery_dispatcher_heartbeat.json")
STATE = Path("/Users/nob/Projects/rpp-8am-notify/rpp_apply_logs/rpp_product_delivery_dispatcher_state.json")
SERVICE = f"gui/{os.getuid()}/com.rise.rpp-product-delivery-dispatcher"
VERIFIER = Path("/Users/nob/Projects/rpp-8am-notify/deploy_worker_runtime.py")
WAL = Path("/Users/nob/Projects/rpp-8am-notify/rpp_apply_logs/rpp_product_delivery_scheduler_wal.json")
AUTO_APPLY_WAL = Path("/Users/nob/Projects/rpp-8am-notify/rpp_apply_logs/rpp_allowed_auto_apply_wal.json")
CIRCUIT = Path("/Users/nob/Projects/rpp-8am-notify/rpp_apply_logs/rpp_product_delivery_scheduler_circuit.json")
MAX_HEARTBEAT_AGE_SECONDS = 15 * 60
MAX_LOCK_BUSY_SECONDS = 10 * 60
MAX_FAILURE_RETRY_SECONDS = 10 * 60
RETRY_REASONS = {"lock-retry", "backlog-retry", "overdue-retry", "startup-retry", "failure-retry"}


def parse_iso(value: object) -> dt.datetime:
    if not isinstance(value, str):
        raise ValueError("timestamp missing")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp timezone missing")
    return parsed.astimezone(UTC)


def fail(code: str) -> int:
    print(json.dumps({"ok": False, "kind": "rppDeliveryDispatcherHealth", "errorCode": code}, sort_keys=True))
    return 1


def main() -> int:
    verification = subprocess.run([sys.executable, "-s", str(VERIFIER), "--verify-only"], capture_output=True, text=True, timeout=90,
                                  env={**os.environ, "PYTHONNOUSERSITE": "1"})
    if verification.returncode != 0:
        return fail("MANIFEST_INVALID")
    try:
        verified = json.loads(verification.stdout)
        expected_commit = str(verified.get("commit") or "")
    except (ValueError, TypeError, json.JSONDecodeError):
        return fail("MANIFEST_RECEIPT_INVALID")
    status = subprocess.run(["launchctl", "print", SERVICE], capture_output=True, text=True)
    if status.returncode != 0:
        return fail("SERVICE_NOT_LOADED")
    try:
        service_pid = validate_loaded_dispatcher(status.stdout)
    except RuntimeError:
        return fail("SERVICE_DEFINITION_INVALID")
    try:
        heartbeat = json.loads(HEARTBEAT.read_text(encoding="utf-8"))
        observed = parse_iso(heartbeat.get("at") or heartbeat.get("armedAt"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return fail("HEARTBEAT_INVALID")
    age = (dt.datetime.now(UTC) - observed).total_seconds()
    if heartbeat.get("ok") is not True:
        return fail("HEARTBEAT_UNHEALTHY")
    if heartbeat.get("listenerConnected") is not True:
        return fail("LISTENER_NOT_CONNECTED")
    if heartbeat.get("reason") in {"startup-retry", "failure-retry"}:
        return fail("DISPATCHER_RETRYING")
    if heartbeat.get("manifestCommit") != expected_commit:
        return fail("RUNTIME_COMMIT_MISMATCH")
    if heartbeat.get("pid") != service_pid:
        return fail("HEARTBEAT_PID_MISMATCH")
    if age < 0 or age > MAX_HEARTBEAT_AGE_SECONDS:
        return fail("HEARTBEAT_STALE")
    try:
        state = json.loads(STATE.read_text(encoding="utf-8"))
        if state.get("reason") == "lock-retry":
            duration = (dt.datetime.now(UTC) - parse_iso(state.get("firstLockBusyAt"))).total_seconds()
            if duration > MAX_LOCK_BUSY_SECONDS:
                return fail("LOCK_BUSY_PERSISTENT")
        if state.get("reason") in {"startup-retry", "failure-retry"}:
            duration = (dt.datetime.now(UTC) - parse_iso(state.get("firstFailureAt"))).total_seconds()
            if duration > MAX_FAILURE_RETRY_SECONDS:
                return fail("DISPATCHER_RETRY_PERSISTENT")
        if state.get("reason") in RETRY_REASONS:
            duration = (dt.datetime.now(UTC) - parse_iso(state.get("firstRetryAt"))).total_seconds()
            if duration > MAX_FAILURE_RETRY_SECONDS:
                return fail("DISPATCHER_RETRY_PERSISTENT")
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return fail("STATE_INVALID")
    if WAL.exists():
        return fail("WAL_PRESENT")
    if AUTO_APPLY_WAL.exists():
        try:
            auto_wal = json.loads(AUTO_APPLY_WAL.read_text(encoding="utf-8"))
            if any(entry.get("state") in {"PREPARED", "SUBMITTING", "SUBMITTED", "UNCERTAIN", "UNKNOWN"}
                   for entry in auto_wal.get("entries", [])):
                return fail("AUTO_APPLY_WAL_UNRESOLVED")
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return fail("AUTO_APPLY_WAL_INVALID")
    if CIRCUIT.exists():
        try:
            if json.loads(CIRCUIT.read_text(encoding="utf-8")).get("open") is True:
                return fail("CIRCUIT_OPEN")
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return fail("CIRCUIT_INVALID")
    if shutil.disk_usage(HEARTBEAT.parent).free < 1024 * 1024 * 1024:
        return fail("DISK_SPACE_LOW")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
