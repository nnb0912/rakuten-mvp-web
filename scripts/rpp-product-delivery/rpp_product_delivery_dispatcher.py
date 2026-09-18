#!/usr/bin/env python3
"""Event-driven dispatcher for RPP product delivery deadlines.

The dispatcher never writes RMS directly. PostgreSQL NOTIFY is only a wake hint;
a full authenticated machine snapshot is fetched before every re-arm, and the
existing manifest-verified scheduler remains the sole mutation path.
"""
from __future__ import annotations

import datetime as dt
import argparse
import hashlib
import json
import os
import re
import select
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.parse
from pathlib import Path
from typing import Callable, Optional
from zoneinfo import ZoneInfo

try:
    import psycopg2
except ImportError:  # pragma: no cover - production preflight reports this
    psycopg2 = None

PROJECT = Path("/Users/nob/Projects/rpp-8am-notify")
DEFAULT_API_BASE = "https://rakuten-mvp-web.onrender.com"
API_BASE = DEFAULT_API_BASE
CHANNEL = "rpp_product_delivery_scheduler"
JST = ZoneInfo("Asia/Tokyo")
UTC = dt.timezone.utc
STATE_PATH = PROJECT / "rpp_apply_logs" / "rpp_product_delivery_dispatcher_state.json"
HEARTBEAT_PATH = PROJECT / "rpp_apply_logs" / "rpp_product_delivery_dispatcher_heartbeat.json"
SCHEDULER = Path(__file__).resolve().with_name("rpp_product_delivery_scheduler.py")
MAX_IDLE_RESYNC_SECONDS = 3 * 60 * 60
LOCK_RETRY_SECONDS = 60
BACKLOG_RETRY_SECONDS = 60
RUNTIME_COMMIT = os.environ.get("RPP_RUNTIME_COMMIT", "")
EXPECTED_DB_HOST = "dpg-da5bpibncjis738eh9bg-a.singapore-postgres.render.com"
EXPECTED_DB_NAME = "rakuten_mvp_web"
LISTENER_ESTABLISHED = False
RETRY_REASONS = {"lock-retry", "backlog-retry", "overdue-retry", "startup-retry", "failure-retry"}


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def now_utc() -> dt.datetime:
    return dt.datetime.now(UTC)


def iso_utc(value: dt.datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def parse_iso(value: object, field: str) -> dt.datetime:
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"{field} must be an ISO datetime")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise RuntimeError(f"{field} must include a timezone")
    return parsed.astimezone(UTC)


def keychain_secret(service: str) -> str:
    result = subprocess.run(["security", "find-generic-password", "-s", service, "-w"], text=True, capture_output=True)
    if result.returncode or not result.stdout.strip():
        raise RuntimeError(f"Keychain secret is unavailable: {service}")
    return result.stdout.strip()


def snapshot_token() -> str:
    return keychain_secret("hermes.rpp.snapshot-sync")


def listener_dsn() -> str:
    dsn = keychain_secret("hermes.rpp.delivery-dispatch-db")
    parsed = urllib.parse.urlparse(dsn)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if (parsed.scheme not in {"postgres", "postgresql"} or parsed.hostname != EXPECTED_DB_HOST
            or parsed.port != 5432 or parsed.path.lstrip("/") != EXPECTED_DB_NAME
            or query.get("sslmode") != ["verify-full"] or not parsed.username or not parsed.password):
        raise RuntimeError("dispatcher PostgreSQL DSN target/TLS policy mismatch")
    return dsn


def fetch_snapshot() -> dict:
    configured = os.environ.get("RPP_DASHBOARD_URL", DEFAULT_API_BASE).rstrip("/")
    if configured != DEFAULT_API_BASE:
        raise RuntimeError("RPP dashboard URL override is forbidden")
    url = f"{DEFAULT_API_BASE}/api/rpp/sync-snapshot?resource=delivery-schedules"
    request = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {snapshot_token()}",
        "Accept": "application/json",
        "User-Agent": "rise-rpp-delivery-dispatcher/1.0",
    })
    response = urllib.request.build_opener(NoRedirectHandler()).open(request, timeout=45)
    try:
        if response.geturl() != url or response.status != 200:
            raise RuntimeError("delivery snapshot final URL/status mismatch")
        payload = json.load(response)
    finally:
        response.close()
    if payload.get("ok") is not True or (payload.get("storage") or {}).get("durable") is not True:
        raise RuntimeError("delivery snapshot is not durable PostgreSQL authority")
    generation = payload.get("generation")
    if not isinstance(generation, int) or isinstance(generation, bool) or generation < 0:
        raise RuntimeError("delivery snapshot generation is invalid")
    parse_iso(payload.get("serverNow"), "serverNow")
    if not isinstance(payload.get("schedules"), list) or not isinstance(payload.get("reservations"), list):
        raise RuntimeError("delivery snapshot arrays are invalid")
    return payload


def parse_hhmm(value: object) -> tuple[int, int]:
    text = str(value or "")
    if len(text) != 5 or text[2] != ":":
        raise RuntimeError("schedule time must be HH:mm")
    hour, minute = int(text[:2]), int(text[3:])
    if not 0 <= hour <= 23 or not 0 <= minute <= 59:
        raise RuntimeError("schedule time must be HH:mm")
    return hour, minute


def next_deadline(snapshot: dict) -> Optional[dt.datetime]:
    server_now = parse_iso(snapshot["serverNow"], "serverNow")
    local_now = server_now.astimezone(JST)
    candidates: list[dt.datetime] = []
    for row in snapshot["schedules"]:
        if not isinstance(row, dict) or row.get("enabled") is not True:
            continue
        for field in ("startTime", "endTime"):
            hour, minute = parse_hhmm(row.get(field))
            candidate = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if candidate <= local_now:
                candidate += dt.timedelta(days=1)
            candidates.append(candidate.astimezone(UTC))
    for row in snapshot["reservations"]:
        if not isinstance(row, dict) or str(row.get("status") or "").upper() != "PENDING":
            raise RuntimeError("machine snapshot contains a non-PENDING reservation")
        execute_at = parse_iso(row.get("executeAt"), "executeAt")
        candidates.append(max(execute_at, server_now))
    return min(candidates) if candidates else None


def atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def persist_arm(snapshot: dict, deadline: Optional[dt.datetime], reason: str, details: Optional[dict] = None,
                healthy: bool = True) -> None:
    retry_details = dict(details or {})
    if reason in RETRY_REASONS and "firstRetryAt" not in retry_details:
        retry_details["firstRetryAt"] = iso_utc(now_utc())
        try:
            previous = json.loads(STATE_PATH.read_text(encoding="utf-8"))
            if previous.get("reason") in RETRY_REASONS and previous.get("firstRetryAt"):
                retry_details["firstRetryAt"] = str(previous["firstRetryAt"])
        except (OSError, ValueError, json.JSONDecodeError):
            pass
    payload = {
        "version": 1,
        "generation": snapshot["generation"],
        "serverNow": snapshot["serverNow"],
        "deadline": iso_utc(deadline) if deadline else None,
        "reason": reason,
        "armedReason": reason,
        "armedAt": iso_utc(now_utc()),
        "manifestCommit": RUNTIME_COMMIT,
        "listenerConnected": LISTENER_ESTABLISHED,
        "pid": os.getpid(),
    }
    if retry_details:
        payload.update(retry_details)
    atomic_json(STATE_PATH, payload)
    atomic_json(HEARTBEAT_PATH, {**payload, "ok": healthy})


def persist_heartbeat(reason: str, details: Optional[dict] = None, healthy: bool = True) -> None:
    payload = {"ok": healthy, "at": iso_utc(now_utc()), "reason": reason, "manifestCommit": RUNTIME_COMMIT,
               "listenerConnected": LISTENER_ESTABLISHED, "pid": os.getpid()}
    if details:
        payload.update(details)
    atomic_json(HEARTBEAT_PATH, payload)


def parse_scheduler_receipt(stdout: str) -> Optional[dict]:
    for line in reversed(stdout.splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get("kind") == "rppDeliveryTick":
            return value
        if isinstance(value, dict) and value.get("kind") == "rppDeliveryDeploymentPreflight":
            return {**value, "deploymentProbe": True}
    return None


def require_private_generation() -> None:
    generation = Path(__file__).resolve().parent
    runtime_root = (PROJECT / "rpp_apply_logs" / "runtime_exec").resolve()
    if runtime_root not in generation.parents or not generation.name.startswith("delivery-dispatcher-generation-"):
        raise RuntimeError("dispatcher requires a private verified generation")
    manifest = json.loads((PROJECT / "rpp_apply_logs" / "rpp_product_delivery_scheduler_deploy.json").read_text(encoding="utf-8"))
    if manifest.get("commit") != RUNTIME_COMMIT:
        raise RuntimeError("dispatcher generation commit mismatch")
    expected = manifest.get("artifacts") or {}
    artifacts = {"schedulerDispatcher": Path(__file__), "scheduler": SCHEDULER,
                 "nightPause": SCHEDULER.with_name("rpp_product_night_pause.py"),
                 "exclusionAdapter": SCHEDULER.with_name("rpp_apply_exclusion_upload.mjs")}
    for key, artifact in artifacts.items():
        resolved = artifact.resolve()
        if (resolved.parent != generation or artifact.is_symlink()
                or hashlib.sha256(resolved.read_bytes()).hexdigest() != expected.get(key)):
            raise RuntimeError("dispatcher sibling artifact is not manifest-attested")


def invoke_scheduler() -> tuple[int, Optional[dict], str]:
    if not SCHEDULER.is_file() or SCHEDULER.is_symlink():
        raise RuntimeError("immutable generation scheduler is unavailable")
    try:
        activation = json.loads((PROJECT / "rpp_apply_logs" / "rpp_product_delivery_dispatcher_activation.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("dispatcher activation receipt is unavailable") from exc
    final_active = bool(activation.get("activated")) and not bool(activation.get("activationHold"))
    probe_active = activation.get("activated") is False and activation.get("probe") is True
    hold_active = activation.get("activated") is True and activation.get("activationHold") is True
    if (not final_active and not probe_active and not hold_active) or activation.get("commit") != RUNTIME_COMMIT:
        raise RuntimeError("dispatcher activation receipt does not match runtime")
    env = os.environ.copy()
    env.update({"RPP_EVENT_DISPATCHER": "1", "PYTHONPATH": str(SCHEDULER.parent),
                "RPP_PROJECT_DIR": str(PROJECT),
                "RPP_ENABLE_PRODUCT_DELIVERY_SCHEDULER": "1",
                "RPP_SETTINGS_REFRESH_SCRIPT": str(SCHEDULER.with_name("scripts_refresh_rpp_settings_csvs.py"))})
    command = ([sys.executable, "-s", str(SCHEDULER), "--execute", "--confirm=RPP_PRODUCT_DELIVERY_SCHEDULER"]
               if final_active else
               [sys.executable, "-s", str(SCHEDULER), "--deployment-preflight",
                "--confirm=RPP_PRODUCT_DELIVERY_DEPLOYMENT_PREFLIGHT"])
    process = subprocess.run(command,
                             env=env, text=True, capture_output=True, timeout=30 * 60)
    output = (process.stdout or "") + (process.stderr or "")
    return process.returncode, parse_scheduler_receipt(process.stdout or ""), output[-4000:]


def connect_listener():
    if psycopg2 is None:
        raise RuntimeError("psycopg2 is required for PostgreSQL LISTEN")
    connection = psycopg2.connect(listener_dsn(), connect_timeout=15, application_name="rpp-product-delivery-dispatcher")
    connection.set_session(autocommit=True)
    cursor = connection.cursor()
    cursor.execute(f"LISTEN {CHANNEL}")
    return connection


def drain_notifications(connection) -> list[int]:
    connection.poll()
    values = []
    while connection.notifies:
        notification = connection.notifies.pop(0)
        try:
            values.append(int(notification.payload))
        except ValueError:
            values.append(-1)
    return values


def delay_from_server(snapshot: dict, deadline: Optional[dt.datetime]) -> float:
    if deadline is None:
        return float(MAX_IDLE_RESYNC_SECONDS)
    server_now = parse_iso(snapshot["serverNow"], "serverNow")
    return max(0.0, min((deadline - server_now).total_seconds(), float(MAX_IDLE_RESYNC_SECONDS)))


def retry_arm_is_active(deadline: Optional[dt.datetime]) -> bool:
    if deadline is None:
        return False
    try:
        armed = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return False
    return armed.get("reason") in RETRY_REASONS


def load_durable_retry(snapshot: dict) -> Optional[tuple[dt.datetime, str, dict]]:
    try:
        armed = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        reason = str(armed.get("reason") or "")
        deadline = parse_iso(armed.get("deadline"), "deadline")
    except (OSError, ValueError, TypeError, json.JSONDecodeError, RuntimeError):
        return None
    server_now = parse_iso(snapshot["serverNow"], "serverNow")
    if (reason not in RETRY_REASONS or armed.get("manifestCommit") != RUNTIME_COMMIT
            or armed.get("generation") != snapshot.get("generation") or deadline <= server_now):
        return None
    details = {key: armed[key] for key in ("firstRetryAt", "firstLockBusyAt", "firstFailureAt", "lastError") if armed.get(key)}
    return deadline, reason, details


def retry_failure_details(error: Exception) -> dict:
    first_failure_at = iso_utc(now_utc())
    try:
        previous = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if previous.get("reason") in {"startup-retry", "failure-retry"} and previous.get("firstFailureAt"):
            first_failure_at = str(previous["firstFailureAt"])
    except (OSError, ValueError, json.JSONDecodeError):
        pass
    return {"lastError": type(error).__name__, "firstFailureAt": first_failure_at}


def persist_waiting_health(snapshot: dict) -> None:
    reason = None
    try:
        reason = json.loads(STATE_PATH.read_text(encoding="utf-8")).get("reason")
    except (OSError, ValueError, json.JSONDecodeError):
        pass
    if reason in {"startup-retry", "failure-retry"}:
        persist_heartbeat(str(reason), {"generation": snapshot["generation"], "armedReason": reason}, healthy=False)
    else:
        persist_heartbeat("waiting", {"generation": snapshot["generation"], "armedReason": reason})


def run_once(reason: str) -> tuple[dict, Optional[dt.datetime]]:
    code, receipt, output = invoke_scheduler()
    if code == 75 or (receipt or {}).get("errorCode") == "LOCK_BUSY":
        snapshot = fetch_snapshot()
        deadline = parse_iso(snapshot["serverNow"], "serverNow") + dt.timedelta(seconds=LOCK_RETRY_SECONDS)
        first_lock_busy_at = iso_utc(now_utc())
        try:
            previous = json.loads(STATE_PATH.read_text(encoding="utf-8"))
            if previous.get("reason") == "lock-retry" and previous.get("firstLockBusyAt"):
                first_lock_busy_at = str(previous["firstLockBusyAt"])
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        persist_arm(snapshot, deadline, "lock-retry", {"firstLockBusyAt": first_lock_busy_at})
        return snapshot, deadline
    if code != 0 or receipt is None or receipt.get("ok") is not True:
        raise RuntimeError(f"scheduler failed during {reason}: exit={code}; machine receipt required; output={output}")
    snapshot = fetch_snapshot()
    if receipt is not None and receipt.get("deploymentProbe") is True:
        deadline = parse_iso(snapshot["serverNow"], "serverNow") + dt.timedelta(seconds=BACKLOG_RETRY_SECONDS)
        persist_arm(snapshot, deadline, "activation-probe")
        return snapshot, deadline
    if receipt is not None and int(receipt.get("queueDepth") or 0) > 0:
        deadline = parse_iso(snapshot["serverNow"], "serverNow") + dt.timedelta(seconds=BACKLOG_RETRY_SECONDS)
        persist_arm(snapshot, deadline, "backlog-retry")
        return snapshot, deadline
    deadline = next_deadline(snapshot)
    if deadline is not None and deadline <= parse_iso(snapshot["serverNow"], "serverNow"):
        deadline = parse_iso(snapshot["serverNow"], "serverNow") + dt.timedelta(seconds=BACKLOG_RETRY_SECONDS)
        persist_arm(snapshot, deadline, "overdue-retry")
        return snapshot, deadline
    persist_arm(snapshot, deadline, reason)
    return snapshot, deadline


def serve(stop: Callable[[], bool]) -> None:
    global LISTENER_ESTABLISHED
    require_private_generation()
    LISTENER_ESTABLISHED = False
    snapshot: Optional[dict] = None
    deadline: Optional[dt.datetime] = None
    backoff = 5
    startup_checked = False
    while snapshot is None and not stop():
        try:
            if not startup_checked:
                startup_checked = True
                candidate = fetch_snapshot()
                durable = load_durable_retry(candidate)
                if durable is not None:
                    deadline, durable_reason, durable_details = durable
                    snapshot = candidate
                    persist_arm(snapshot, deadline, durable_reason, durable_details,
                                healthy=durable_reason not in {"startup-retry", "failure-retry"})
                    continue
            snapshot, deadline = run_once("startup-reconcile")
        except Exception as exc:
            try:
                snapshot = fetch_snapshot()
                deadline = parse_iso(snapshot["serverNow"], "serverNow") + dt.timedelta(seconds=BACKLOG_RETRY_SECONDS)
                details = retry_failure_details(exc)
                persist_arm(snapshot, deadline, "startup-retry", details, healthy=False)
                persist_heartbeat("startup-retry", {"generation": snapshot["generation"], **details}, healthy=False)
            except Exception as snapshot_exc:
                persist_heartbeat("startup-retry", {"error": type(snapshot_exc).__name__}, healthy=False)
                time.sleep(backoff)
                backoff = min(300, backoff * 2)
    if snapshot is None:
        return
    wake_at = time.monotonic() + delay_from_server(snapshot, deadline)
    connection = None
    backoff = 5
    while not stop():
        try:
            if connection is None or connection.closed:
                connection = connect_listener()
                LISTENER_ESTABLISHED = True
                latest = fetch_snapshot()
                if latest["generation"] < snapshot["generation"]:
                    raise RuntimeError("delivery generation moved backwards")
                if latest["generation"] != snapshot["generation"]:
                    snapshot, deadline = run_once("db-reconnect-generation")
                else:
                    snapshot = latest
                    if not retry_arm_is_active(deadline):
                        deadline = next_deadline(snapshot)
                        persist_arm(snapshot, deadline, "db-reconnect")
                persist_waiting_health(snapshot)
                wake_at = time.monotonic() + delay_from_server(snapshot, deadline)
                backoff = 5
            timeout = max(0.0, min(wake_at - time.monotonic(), 300.0))
            readable, _, _ = select.select([connection], [], [], timeout)
            if stop():
                break
            if readable:
                notifications = drain_notifications(connection)
                if notifications:
                    # A notification can correspond to a mutation committed while
                    # the preceding worker was running. Reconcile every wake even
                    # when the post-run snapshot already carries its generation.
                    snapshot, deadline = run_once("db-notify-reconcile")
                    wake_at = time.monotonic() + delay_from_server(snapshot, deadline)
                continue
            if time.monotonic() < wake_at:
                persist_waiting_health(snapshot)
                continue
            latest = fetch_snapshot()
            if latest["generation"] < snapshot["generation"]:
                raise RuntimeError("delivery generation moved backwards")
            snapshot = latest
            server_now = parse_iso(snapshot["serverNow"], "serverNow")
            if deadline is not None and deadline <= server_now:
                snapshot, deadline = run_once("deadline")
            else:
                deadline = next_deadline(snapshot)
                persist_arm(snapshot, deadline, "periodic-resync")
            wake_at = time.monotonic() + delay_from_server(snapshot, deadline)
        except Exception as exc:
            try:
                retry_snapshot = fetch_snapshot()
                if retry_snapshot["generation"] < snapshot["generation"]:
                    raise RuntimeError("delivery generation moved backwards")
                snapshot = retry_snapshot
                deadline = parse_iso(snapshot["serverNow"], "serverNow") + dt.timedelta(seconds=BACKLOG_RETRY_SECONDS)
            except Exception:
                deadline = now_utc() + dt.timedelta(seconds=BACKLOG_RETRY_SECONDS)
            details = retry_failure_details(exc)
            LISTENER_ESTABLISHED = False
            persist_arm(snapshot, deadline, "failure-retry", details, healthy=False)
            print(json.dumps({"ok": False, "kind": "rppDeliveryDispatcher", "error": str(exc)[:1000]}, ensure_ascii=False), flush=True)
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass
                connection = None
            time.sleep(backoff)
            backoff = min(300, backoff * 2)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preflight", action="store_true")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[0-9a-f]{40}", RUNTIME_COMMIT):
        raise RuntimeError("attested runtime commit is unavailable")
    if args.preflight:
        snapshot = fetch_snapshot()
        connection = connect_listener()
        connection.close()
        print(json.dumps({"ok": True, "kind": "rppDeliveryDispatcherPreflight",
                          "productionChange": False, "generation": snapshot["generation"],
                          "serverNow": snapshot["serverNow"], "listenerConnected": True}, sort_keys=True))
        return 0
    stopped = False

    def request_stop(_signum, _frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    serve(lambda: stopped)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
