#!/usr/bin/env python3
"""Safely reconcile product-level RPP delivery schedules.

Dry-run is the default. Production execution requires an environment gate and an
exact confirmation. Production runs acquire the shared RMS exclusion lock before
reading any state, refresh and completeness-check the full exclusion snapshot,
and journal each RMS transition to a fsync'd WAL before submission.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, NoReturn, Optional, Set, Tuple
from zoneinfo import ZoneInfo

import rpp_product_night_pause as legacy

PROJECT = Path(os.environ.get("RPP_PROJECT_DIR", "/Users/nob/Projects/rpp-8am-notify"))
DEFAULT_API_BASE = "https://rakuten-mvp-web.onrender.com"
API_BASE = DEFAULT_API_BASE
STATE_PATH = PROJECT / "rpp_apply_logs" / "rpp_product_delivery_scheduler_state.json"
WAL_PATH = PROJECT / "rpp_apply_logs" / "rpp_product_delivery_scheduler_wal.json"
AUDIT_PATH = PROJECT / "rpp_apply_logs" / "rpp_product_delivery_scheduler_audit.jsonl"
CIRCUIT_PATH = PROJECT / "rpp_apply_logs" / "rpp_product_delivery_scheduler_circuit.json"
ON_GUARD_ALERT_PATH = PROJECT / "rpp_apply_logs" / "rpp_product_delivery_scheduler_on_guard.json"
LOCK_BUSY_ALERT_PATH = PROJECT / "rpp_apply_logs" / "rpp_product_delivery_scheduler_lock_busy.json"
EXCLUDE_CSV = PROJECT / "rpp_exclude_items.csv"
REFRESH_SCRIPT = Path(os.environ.get("RPP_SETTINGS_REFRESH_SCRIPT", str(PROJECT / "scripts_refresh_rpp_settings_csvs.py")))
JST = ZoneInfo("Asia/Tokyo")
UTC = dt.timezone.utc
PRODUCTION_CONFIRMATION = "RPP_PRODUCT_DELIVERY_SCHEDULER"
CIRCUIT_RESET_CONFIRMATION = "RPP_CIRCUIT_RESET"
CIRCUIT_PROBE_CONFIRMATION = "RPP_CIRCUIT_PROBE"
STATE_VERSION = 3
AUDIT_MAX_BYTES = 10 * 1024 * 1024


def max_actions_per_tick() -> int:
    try:
        # Production rollout is deliberately canaried.  No environment override
        # may raise the number of RMS writes above three in a single tick.
        return max(1, min(3, int(os.environ.get("RPP_SCHEDULER_MAX_ACTIONS_PER_TICK", "3"))))
    except ValueError as exc:
        raise RuntimeError("RPP_SCHEDULER_MAX_ACTIONS_PER_TICK must be an integer") from exc


def now_utc() -> dt.datetime:
    return dt.datetime.now(UTC)


def iso_utc(value: dt.datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def parse_iso(value: object) -> dt.datetime:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError("executeAt must be an ISO datetime")
    parsed = dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise RuntimeError("executeAt must include a timezone")
    return parsed.astimezone(UTC)


def parse_hhmm(value: object) -> int:
    if not isinstance(value, str) or len(value) != 5 or value[2] != ":":
        raise RuntimeError("time must be HH:mm")
    try:
        hour, minute = (int(part) for part in value.split(":"))
    except ValueError as exc:
        raise RuntimeError("time must be HH:mm") from exc
    if not 0 <= hour <= 23 or not 0 <= minute <= 59:
        raise RuntimeError("time must be HH:mm")
    return hour * 60 + minute


def interval_active(at: dt.datetime, start_time: str, end_time: str) -> bool:
    start = parse_hhmm(start_time)
    end = parse_hhmm(end_time)
    if start == end:
        raise RuntimeError("startTime and endTime must differ")
    local = at.astimezone(JST)
    current = local.hour * 60 + local.minute
    return start <= current < end if start < end else current >= start or current < end


def normalize_schedule_payload(payload: object) -> Tuple[List[dict], List[dict], Set[str], Set[str]]:
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise RuntimeError("delivery-schedules response must contain ok=true")
    raw_schedules = payload.get("schedules")
    raw_reservations = payload.get("reservations")
    raw_release_allowed = payload.get("releaseAllowedItemCodes")
    if not isinstance(raw_schedules, list) or not isinstance(raw_reservations, list) or not isinstance(raw_release_allowed, list):
        raise RuntimeError("delivery-schedules response arrays are invalid")
    schedules: List[dict] = []
    schedule_codes: Set[str] = set()
    for row in raw_schedules:
        if not isinstance(row, dict):
            raise RuntimeError("schedule row is invalid")
        code = legacy.normalize_code(row.get("itemCode"))
        if code in schedule_codes:
            raise RuntimeError("duplicate schedule itemCode: %s" % code)
        schedule_codes.add(code)
        start, end = row.get("startTime"), row.get("endTime")
        parse_hhmm(start)
        parse_hhmm(end)
        if start == end:
            raise RuntimeError("startTime and endTime must differ")
        schedules.append({"itemCode": code, "enabled": row.get("enabled") is True, "startTime": start, "endTime": end})
    reservations: List[dict] = []
    reservation_ids: Set[str] = set()
    for row in raw_reservations:
        if not isinstance(row, dict):
            raise RuntimeError("reservation row is invalid")
        reservation_id = str(row.get("id") or "").strip()
        code = legacy.normalize_code(row.get("itemCode"))
        action = str(row.get("action") or "").upper()
        status = str(row.get("status") or "").upper()
        if not reservation_id or reservation_id in reservation_ids or action not in {"ON", "OFF"} or status != "PENDING":
            raise RuntimeError("pending reservation row is invalid")
        reservation_ids.add(reservation_id)
        claim_id = str(row.get("claimId") or "").strip() or None
        claim_expires_at = parse_iso(row.get("claimExpiresAt")) if row.get("claimExpiresAt") else None
        reservations.append({"id": reservation_id, "itemCode": code, "action": action,
                             "executeAt": parse_iso(row.get("executeAt")), "claimId": claim_id,
                             "claimExpiresAt": claim_expires_at,
                             "orphaned": row.get("orphaned") is True,
                             "attemptCount": row.get("attempts"), "nextAttemptAt": row.get("nextAttemptAt")})
    schedules.sort(key=lambda row: row["itemCode"])
    reservations.sort(key=lambda row: (row["executeAt"], row["id"]))
    release_allowed = {legacy.normalize_code(code) for code in raw_release_allowed}
    orphaned_rows = list(payload.get("orphanedSchedules") or []) + list(payload.get("orphanedReservations") or [])
    orphaned = {legacy.normalize_code(row.get("itemCode")) for row in orphaned_rows if isinstance(row, dict)}
    return schedules, reservations, release_allowed, orphaned


def require_durable_schedule_storage(payload: object) -> None:
    storage = payload.get("storage") if isinstance(payload, dict) else None
    if not isinstance(storage, dict) or storage.get("source") != "postgres" or storage.get("durable") is not True:
        raise RuntimeError("delivery-schedules response storage is not durable PostgreSQL")


def fetch_json(url: str, method: str = "GET", body: Optional[dict] = None) -> dict:
    configured = os.environ.get("RPP_DASHBOARD_URL", DEFAULT_API_BASE).rstrip("/")
    if configured != DEFAULT_API_BASE or not url.startswith(DEFAULT_API_BASE + "/api/rpp/"):
        raise RuntimeError("RPP dashboard URL override is forbidden")
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": "Bearer %s" % legacy.snapshot_token(),
        "Accept": "application/json", "Content-Type": "application/json",
        "User-Agent": "rise-rpp-product-delivery-scheduler/2.0",
    })
    try:
        with legacy.open_exact_url(request, url, timeout=45) as response:
            payload = json.load(response)
            if response.status != 200:
                raise RuntimeError("schedule API failed: HTTP %s" % response.status)
            return payload
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise RuntimeError("schedule API failed: HTTP %s %s" % (exc.code, detail)) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError("schedule API failed: %s" % exc.reason) from exc


def fetch_delivery_schedules(api_base: str = API_BASE) -> Tuple[List[dict], List[dict], Set[str], Set[str]]:
    query = urllib.parse.urlencode({"resource": "delivery-schedules"})
    payload = fetch_json("%s/api/rpp/sync-snapshot?%s" % (api_base.rstrip("/"), query))
    require_durable_schedule_storage(payload)
    return normalize_schedule_payload(payload)


def claim_reservation(reservation_id: str, api_base: str = API_BASE) -> dict:
    query = urllib.parse.urlencode({"resource": "delivery-schedules"})
    payload = fetch_json("%s/api/rpp/sync-snapshot?%s" % (api_base.rstrip("/"), query), method="POST", body={
        "operation": "CLAIM", "reservationId": reservation_id,
    })
    row = payload.get("reservation") if isinstance(payload, dict) else None
    if payload.get("ok") is not True or not isinstance(row, dict) or not row.get("claimId"):
        raise RuntimeError("reservation claim failed")
    return row


def heartbeat_reservation(reservation_id: str, claim_id: str, api_base: str = API_BASE) -> dict:
    query = urllib.parse.urlencode({"resource": "delivery-schedules"})
    payload = fetch_json("%s/api/rpp/sync-snapshot?%s" % (api_base.rstrip("/"), query), method="POST", body={
        "operation": "HEARTBEAT", "reservationId": reservation_id, "claimId": claim_id,
    })
    row = payload.get("reservation") if isinstance(payload, dict) else None
    if payload.get("ok") is not True or not isinstance(row, dict) or row.get("claimId") != claim_id:
        raise RuntimeError("reservation heartbeat/fencing failed")
    return row


def release_reservation_claim(reservation_id: str, claim_id: str, error: str, api_base: str = API_BASE) -> dict:
    query = urllib.parse.urlencode({"resource": "delivery-schedules"})
    payload = fetch_json("%s/api/rpp/sync-snapshot?%s" % (api_base.rstrip("/"), query), method="POST", body={
        "operation": "RELEASE", "reservationId": reservation_id, "claimId": claim_id, "error": error[-1000:],
    })
    row = payload.get("reservation") if isinstance(payload, dict) else None
    if payload.get("ok") is not True or not isinstance(row, dict) or row.get("claimId") is not None or row.get("status") != "PENDING":
        raise RuntimeError("reservation claim release failed")
    return row


def acknowledge_reservation(reservation_id: str, claim_id: str, status: str, error: str = "", api_base: str = API_BASE) -> dict:
    if status not in {"SUCCEEDED", "FAILED"}:
        raise ValueError("status must be SUCCEEDED or FAILED")
    query = urllib.parse.urlencode({"resource": "delivery-schedules"})
    payload = fetch_json("%s/api/rpp/sync-snapshot?%s" % (api_base.rstrip("/"), query), method="POST", body={
        "reservationId": reservation_id, "claimId": claim_id, "status": status, "error": error[-1000:],
    })
    if payload.get("ok") is not True:
        raise RuntimeError("reservation acknowledgement failed")
    return payload


def default_state() -> dict:
    return {
        "version": STATE_VERSION,
        "updatedAt": iso_utc(dt.datetime(1970, 1, 1, tzinfo=UTC)),
        "lastRmsSnapshotAt": iso_utc(dt.datetime(1970, 1, 1, tzinfo=UTC)),
        "legacyLedgerMigrated": False,
        "owned": [],
        "preexisting": [],
        "reservationOff": [],
        "overrideOn": [],
        "processedReservations": {},
        "occurrenceQueue": [],
    }


def normalize_state(value: object) -> dict:
    if not isinstance(value, dict):
        raise RuntimeError("scheduler state is invalid")
    state = default_state()
    state.update(copy.deepcopy(value))
    state["version"] = STATE_VERSION
    for key in ("owned", "preexisting", "reservationOff", "overrideOn"):
        values = state.get(key)
        if not isinstance(values, list):
            raise RuntimeError("scheduler state %s is invalid" % key)
        state[key] = sorted({legacy.normalize_code(item) for item in values})
    if not isinstance(state.get("processedReservations"), dict):
        raise RuntimeError("scheduler processedReservations is invalid")
    state["lastRmsSnapshotAt"] = iso_utc(parse_iso(state.get("lastRmsSnapshotAt")))
    queue = state.get("occurrenceQueue")
    if not isinstance(queue, list):
        raise RuntimeError("scheduler occurrenceQueue is invalid")
    normalized_queue = []
    seen_entries = set()
    for entry in queue:
        if not isinstance(entry, dict):
            raise RuntimeError("scheduler occurrenceQueue entry is invalid")
        occurrence_id = str(entry.get("occurrenceId") or "").strip()
        action = str(entry.get("action") or "").upper()
        status = str(entry.get("status") or "").upper()
        code = legacy.normalize_code(entry.get("itemCode"))
        due_at = iso_utc(parse_iso(entry.get("dueAt")))
        key = (occurrence_id, action)
        if (not occurrence_id or action not in {"OFF", "ON"}
                or status not in {"PENDING", "SUCCEEDED", "PREEXISTING", "MISSED", "SKIPPED"}
                or key in seen_entries):
            raise RuntimeError("scheduler occurrenceQueue entry is invalid")
        seen_entries.add(key)
        normalized_queue.append({"occurrenceId": occurrence_id, "itemCode": code,
                                 "action": action, "dueAt": due_at, "status": status})
    state["occurrenceQueue"] = sorted(normalized_queue, key=lambda row: (row["dueAt"], row["occurrenceId"], row["action"]))
    if not isinstance(state.get("legacyLedgerMigrated"), bool):
        raise RuntimeError("scheduler legacyLedgerMigrated is invalid")
    return state


def load_state(path: Path = STATE_PATH) -> dict:
    return normalize_state(json.loads(path.read_text(encoding="utf-8"))) if path.exists() else default_state()


def prune_state_history(state: dict, reservations: Iterable[dict], at: dt.datetime, retention_days: int = 30) -> dict:
    next_state = copy.deepcopy(state)
    cutoff = at.astimezone(UTC) - dt.timedelta(days=retention_days)
    pending_ids = {str(row.get("id") or "") for row in reservations}
    retained_processed = {}
    for reservation_id, row in next_state["processedReservations"].items():
        if reservation_id in pending_ids:
            retained_processed[reservation_id] = row
            continue
        try:
            if parse_iso(row.get("processedAt")) >= cutoff:
                retained_processed[reservation_id] = row
        except (AttributeError, RuntimeError, ValueError):
            retained_processed[reservation_id] = row
    next_state["processedReservations"] = retained_processed
    terminal = {"SUCCEEDED", "PREEXISTING", "MISSED", "SKIPPED"}
    next_state["occurrenceQueue"] = [
        row for row in next_state["occurrenceQueue"]
        if row.get("status") not in terminal or parse_iso(row.get("dueAt")) >= cutoff
    ]
    return next_state


def _fsync_parent(path: Path) -> None:
    fd = os.open(str(path.parent), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_json_write(payload: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        _fsync_parent(path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _failure_category(error: object) -> Optional[str]:
    text = str(error)
    lowered = text.lower()
    if "rms_challenge" in lowered or "captcha" in lowered or "画像認証" in text:
        return "CAPTCHA"
    if "rms_readback_uncertain" in lowered or "rms result is uncertain" in lowered or "rms結果がuncertain" in lowered:
        return "RMS_UNCERTAIN"
    if any(token in lowered for token in ("rms_snapshot_incomplete", "completeness/output mismatch", "snapshot is stale", "expected_count")) \
            or "件数不一致" in text:
        return "RMS_SNAPSHOT_INCOMPLETE"
    if any(token in lowered for token in ("delivery-schedules response", "pending reservation row is invalid", "schedule row is invalid")):
        return "SCHEDULE_API_SCHEMA"
    if any(token in lowered for token in ("rms_auth_required", "unauthorized", "forbidden", "login required", "session expired")) \
            or "ログイン" in text or "認証切れ" in text or re.search(r"(?:^|\D)(?:401|403)(?:\D|$)", text):
        return "AUTH"
    if "rms_dom_drift" in lowered or ("rms" in lowered and any(token in lowered for token in ("selector", "locator", "dom", "element not found"))) \
            or "rms画面" in lowered or "画面仕様" in text:
        return "RMS_DOM"
    if any(token in lowered for token in ("rms_network", "timed out", "timeout", "connection reset", "connection refused",
                                            "temporary failure", "schedule api failed", "network is unreachable",
                                            "urlopen error")) or "通信" in text:
        return "NETWORK"
    return None


def _failure_signature(category: str, error: object) -> str:
    normalized = re.sub(r"\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b", "<id>", str(error).lower())
    normalized = re.sub(r"\d+", "#", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()[:500]
    return "%s:%s" % (category, hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16])


def _must_stop_same_tick(error: object) -> bool:
    return _failure_category(error) in {"CAPTCHA", "AUTH", "RMS_DOM", "RMS_SNAPSHOT_INCOMPLETE",
                                        "SCHEDULE_API_SCHEMA", "RMS_UNCERTAIN"}


def load_circuit(path: Path = CIRCUIT_PATH) -> dict:
    if not path.exists():
        return {"open": False, "category": None, "signature": None, "consecutive": 0,
                "openedAt": None, "lastFailureAt": None, "lastError": None}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or not isinstance(value.get("open"), bool):
            raise ValueError("invalid circuit payload")
        return value
    except (OSError, ValueError, json.JSONDecodeError):
        # A damaged safety state must stop production rather than silently reset.
        return {"open": True, "category": "STATE_CORRUPT", "signature": "STATE_CORRUPT",
                "consecutive": 1, "openedAt": iso_utc(now_utc()), "lastFailureAt": iso_utc(now_utc()),
                "lastError": "circuit breaker state is invalid"}


def record_external_failure(error: object, path: Path = CIRCUIT_PATH, threshold: int = 3) -> dict:
    category = _failure_category(error)
    if category is None:
        return {"status": "ignored", "open": False, "notify": False}
    signature = _failure_signature(category, error)
    previous = load_circuit(path)
    same = previous.get("signature") == signature
    consecutive = int(previous.get("consecutive") or 0) + 1 if same else 1
    immediate = category in {"CAPTCHA", "AUTH", "RMS_DOM", "RMS_UNCERTAIN", "RMS_SNAPSHOT_INCOMPLETE", "SCHEDULE_API_SCHEMA"}
    was_open = bool(previous.get("open")) and same
    opened = was_open or immediate or consecutive >= max(1, threshold)
    timestamp = iso_utc(now_utc())
    payload = {
        "open": opened,
        "category": category,
        "signature": signature,
        "consecutive": consecutive,
        "openedAt": previous.get("openedAt") if was_open else (timestamp if opened else None),
        "lastFailureAt": timestamp,
        "lastError": str(error)[-500:],
    }
    atomic_json_write(payload, path)
    return {**payload, "status": "open" if opened else "counting", "notify": opened and not was_open}


def reset_circuit(path: Path = CIRCUIT_PATH) -> None:
    if path.exists():
        path.unlink()
        _fsync_parent(path)


def update_on_guard_alerts(item_codes: Set[str], path: Path = ON_GUARD_ALERT_PATH) -> dict:
    codes = sorted({legacy.normalize_code(code) for code in item_codes})
    previous: Set[str] = set()
    if path.exists():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            previous = {legacy.normalize_code(code) for code in payload.get("itemCodes", [])}
        except (OSError, ValueError, json.JSONDecodeError):
            previous = set()
    if not codes:
        resolved = bool(previous)
        if path.exists():
            path.unlink()
            _fsync_parent(path)
        return {"notify": False, "resolved": resolved, "itemCodes": [], "newItemCodes": []}
    new_codes = sorted(set(codes) - previous)
    atomic_json_write({"itemCodes": codes, "updatedAt": iso_utc(now_utc())}, path)
    return {"notify": bool(new_codes), "resolved": False, "itemCodes": codes, "newItemCodes": new_codes}


def notification_summary(summary: dict, audit_path: Path = AUDIT_PATH) -> dict:
    limit = max(1, int(summary.get("maxActionsPerTick") or 1))
    queue_depth = max(0, int(summary.get("queueDepth") or 0))
    blocked = summary.get("blocked") is True
    ticks = None if blocked else (int(math.ceil(queue_depth / limit)) if queue_depth else 0)
    compact_changes = [{key: row.get(key) for key in ("itemCode", "action", "productionChange") if key in row}
                       for row in summary.get("changes", [])[:10]]
    compact_failures = [{key: row.get(key) for key in ("itemCode", "reservationId", "retryable", "blocksRms", "error") if key in row}
                        for row in summary.get("failures", [])[:10]]
    earliest = None
    if isinstance(ticks, int) and ticks > 0 and summary.get("observedAt"):
        earliest = iso_utc(parse_iso(summary["observedAt"]) + dt.timedelta(minutes=ticks))
    return {
        "schemaVersion": 1,
        "kind": "rppDeliveryTick",
        "tickId": summary.get("tickId"),
        "at": summary.get("observedAt"),
        "ok": summary.get("ok") is True,
        "dryRun": summary.get("dryRun") is True,
        "changes": compact_changes,
        "failures": compact_failures,
        "completedReservationCount": len(summary.get("completedReservations", [])),
        "activeRecurringCount": len(summary.get("activeRecurring", [])),
        "desiredOffCount": len(summary.get("desiredOff", [])),
        "ownedAfterCount": len(summary.get("ownedAfter", [])),
        "preexistingAfterCount": len(summary.get("preexistingAfter", [])),
        "queueDepth": queue_depth,
        "blocked": blocked,
        "estimatedTicksRemaining": ticks,
        "estimatedCompletionMinutes": ticks,
        "earliestCompletionAt": earliest,
        "omittedChanges": max(0, len(summary.get("changes", [])) - 10),
        "omittedFailures": max(0, len(summary.get("failures", [])) - 10),
        "rolloutPolicy": {"mode": "BOUNDED_CANARY", "maxActionsPerTick": limit},
        "walRecovery": summary.get("walRecovery", {"status": "none"}),
        "circuitBreaker": summary.get("circuitBreaker", {"open": False}),
        "warnings": list(summary.get("warnings", []))[:10],
        "audit": {"path": str(audit_path), "tickId": summary.get("tickId")},
    }


def save_state(state: dict, path: Path = STATE_PATH) -> None:
    payload = normalize_state(state)
    payload["updatedAt"] = iso_utc(now_utc())
    atomic_json_write(payload, path)


def write_wal(entry: dict, path: Path = WAL_PATH) -> None:
    atomic_json_write(entry, path)


def clear_wal(path: Path = WAL_PATH) -> None:
    if path.exists():
        path.unlink()
        _fsync_parent(path)


def load_wal(path: Path = WAL_PATH) -> Optional[dict]:
    if not path.exists():
        return None
    value = json.loads(path.read_text(encoding="utf-8"))
    if (not isinstance(value, dict) or value.get("control") not in {"n", "d"}
            or value.get("phase") not in {"PREPARED", "SUBMITTING", "SUBMITTED", "VERIFIED", "UNCERTAIN"}
            or not isinstance(value.get("stateBefore"), dict) or not isinstance(value.get("stateAfter"), dict)):
        raise RuntimeError("scheduler WAL is invalid")
    value["itemCode"] = legacy.normalize_code(value.get("itemCode"))
    value["stateBefore"] = normalize_state(value["stateBefore"])
    value["stateAfter"] = normalize_state(value["stateAfter"])
    return value


def recurring_holds(at: dt.datetime, schedules: Iterable[dict], legacy_codes: Iterable[str]) -> Set[str]:
    holds = {row["itemCode"] for row in schedules if row.get("enabled") is True and interval_active(at, row["startTime"], row["endTime"])}
    local = at.astimezone(JST)
    if 90 <= local.hour * 60 + local.minute < 360:
        holds.update(legacy.normalize_code(code) for code in legacy_codes)
    return holds


def desired_holds(state: dict, raw_recurring: Set[str]) -> Set[str]:
    return (set(raw_recurring) - set(state["overrideOn"])) | set(state["reservationOff"])


def _occurrence_window(schedule: dict, local_day: dt.date) -> Tuple[dt.datetime, dt.datetime]:
    start_minutes = parse_hhmm(schedule["startTime"])
    end_minutes = parse_hhmm(schedule["endTime"])
    start = dt.datetime.combine(local_day, dt.time(start_minutes // 60, start_minutes % 60), JST)
    end_day = local_day + dt.timedelta(days=1) if end_minutes <= start_minutes else local_day
    end = dt.datetime.combine(end_day, dt.time(end_minutes // 60, end_minutes % 60), JST)
    return start.astimezone(UTC), end.astimezone(UTC)


def sync_occurrence_queue(state: dict, schedules: Iterable[dict], at: dt.datetime) -> Tuple[dict, List[str]]:
    """Persist each interval occurrence so capacity backlog cannot disappear."""
    next_state = copy.deepcopy(state)
    queue = next_state["occurrenceQueue"]
    existing = {(row["occurrenceId"], row["action"]) for row in queue}
    local_day = at.astimezone(JST).date()
    last_tick = parse_iso(next_state.get("updatedAt"))
    initialized = last_tick > dt.datetime(1971, 1, 1, tzinfo=UTC)
    for schedule in schedules:
        if schedule.get("enabled") is not True:
            continue
        for day in (local_day - dt.timedelta(days=1), local_day):
            start, end = _occurrence_window(schedule, day)
            # Create active occurrences and occurrences crossed since the last tick.
            if start > at or (end <= at and (not initialized or start < last_tick)):
                continue
            occurrence_id = "%s:%s:%s" % (schedule["itemCode"], iso_utc(start), iso_utc(end))
            for action, due in (("OFF", start), ("ON", end)):
                key = (occurrence_id, action)
                if key not in existing:
                    queue.append({"occurrenceId": occurrence_id, "itemCode": schedule["itemCode"],
                                  "action": action, "dueAt": iso_utc(due), "status": "PENDING"})
                    existing.add(key)
    warnings: List[str] = []
    by_occurrence: Dict[str, Dict[str, dict]] = {}
    for row in queue:
        by_occurrence.setdefault(row["occurrenceId"], {})[row["action"]] = row
    for occurrence_id, actions in by_occurrence.items():
        off, on = actions.get("OFF"), actions.get("ON")
        if not off or not on:
            raise RuntimeError("scheduler occurrenceQueue pair is incomplete: %s" % occurrence_id)
        if off["status"] == "PENDING" and parse_iso(on["dueAt"]) <= at:
            off["status"] = "MISSED"
            on["status"] = "SKIPPED"
            warnings.append("時間帯内にOFFを開始できずMISSED: %s (%s)" % (off["itemCode"], occurrence_id))
    cutoff = at - dt.timedelta(days=14)
    next_state["occurrenceQueue"] = sorted([
        row for row in queue
        if row["status"] == "PENDING" or parse_iso(row["dueAt"]) >= cutoff
    ], key=lambda row: (row["dueAt"], row["occurrenceId"], row["action"]))
    return next_state, warnings


def settle_occurrence_queue(state: dict, current: Set[str], at: dt.datetime) -> dict:
    """Record OFF ownership/preexistence and eventual owned ON restoration."""
    next_state = copy.deepcopy(state)
    owned, preexisting = set(next_state["owned"]), set(next_state["preexisting"])
    by_occurrence: Dict[str, Dict[str, dict]] = {}
    for row in next_state["occurrenceQueue"]:
        by_occurrence.setdefault(row["occurrenceId"], {})[row["action"]] = row
    for actions in by_occurrence.values():
        off, on = actions.get("OFF"), actions.get("ON")
        if not off or not on:
            continue
        code = off["itemCode"]
        if off["status"] == "PENDING" and parse_iso(off["dueAt"]) <= at and parse_iso(on["dueAt"]) > at and code in current:
            off["status"] = "SUCCEEDED" if code in owned else "PREEXISTING"
        if on["status"] == "PENDING" and parse_iso(on["dueAt"]) <= at:
            if off["status"] in {"MISSED", "PREEXISTING"}:
                on["status"] = "SKIPPED"
            elif off["status"] == "SUCCEEDED" and code not in owned and code not in current:
                on["status"] = "SUCCEEDED"
    return next_state


def append_audit(entry: dict, path: Path = AUDIT_PATH, max_bytes: int = AUDIT_MAX_BYTES, keep: int = 7) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(path.name + ".lock")
    with lock_path.open("a", encoding="utf-8") as lock_handle:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        try:
            if path.exists() and path.stat().st_size >= max_bytes:
                stamp = now_utc().strftime("%Y%m%dT%H%M%S")
                rotated = path.with_name("%s.%s-%s.jsonl" % (path.stem, stamp, uuid.uuid4().hex[:8]))
                os.replace(path, rotated)
                _fsync_parent(path)
                backups = sorted(path.parent.glob(path.stem + ".*-*.jsonl"), key=lambda item: item.stat().st_mtime, reverse=True)
                for old in backups[max(1, keep):]:
                    old.unlink()
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        finally:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)


def require_gate(execute: bool, confirmation: Optional[str], environ: Mapping[str, str]) -> None:
    if execute and environ.get("RPP_ENABLE_PRODUCT_DELIVERY_SCHEDULER") != "1":
        raise RuntimeError("RPP_ENABLE_PRODUCT_DELIVERY_SCHEDULER=1 is required for --execute")
    if execute and confirmation != PRODUCTION_CONFIRMATION:
        raise RuntimeError("--confirm=%s is required for --execute" % PRODUCTION_CONFIRMATION)


def refresh_exclusions(output_path: Path) -> dict:
    if not REFRESH_SCRIPT.exists():
        raise RuntimeError("exclusion refresh script was not found: %s" % REFRESH_SCRIPT)
    started = now_utc().timestamp()
    process = subprocess.run(["/usr/bin/python3", str(REFRESH_SCRIPT), "--exclude-only", "--exclude-output", str(output_path)],
                             cwd=str(PROJECT), text=True, capture_output=True, timeout=600)
    if process.returncode != 0:
        detail = (process.stderr or process.stdout or "refresh exit %s" % process.returncode).strip()
        raise RuntimeError(detail[-3000:])
    try:
        receipt = json.loads(process.stdout)
        snapshot = receipt["exclude"]
        rows, expected = snapshot["rows"], snapshot["expected_count"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise RuntimeError("exclusion refresh receipt is invalid") from exc
    if rows != expected or Path(snapshot.get("output", "")).resolve() != output_path.resolve():
        raise RuntimeError("exclusion refresh completeness/output mismatch")
    if not output_path.exists() or output_path.stat().st_mtime < started - 2:
        raise RuntimeError("exclusion snapshot is stale")
    return receipt


def migrate_legacy_ledger(state: dict, state_path: Path) -> dict:
    if state["legacyLedgerMigrated"]:
        return state
    migrated = copy.deepcopy(state)
    migrated["owned"] = sorted(set(migrated["owned"]) | legacy.read_ledger())
    migrated["legacyLedgerMigrated"] = True
    save_state(migrated, state_path)
    legacy.write_ledger(set())
    return migrated


def recover_wal(state: dict, current: Set[str], state_path: Path, wal_path: Path, audit_path: Path) -> Tuple[dict, dict]:
    wal = load_wal(wal_path)
    if wal is None:
        return state, {"status": "none"}
    expected_excluded = wal["control"] == "n"
    actual_excluded = wal["itemCode"] in current
    phase = wal["phase"]
    safely_attributed = (phase in {"SUBMITTED", "UNCERTAIN"}
                         and bool(wal.get("submittedAt"))
                         and wal.get("beforeExcluded") is (not expected_excluded)
                         and actual_excluded == expected_excluded)
    if (phase == "VERIFIED" and actual_excluded == expected_excluded) or safely_attributed:
        state = wal["stateAfter"]
        save_state(state, state_path)
        status = "committed" if phase == "VERIFIED" else "recovered_committed"
        clear_wal(wal_path)
    elif phase == "PREPARED":
        state = wal["stateBefore"]
        save_state(state, state_path)
        status = "rolled_back"
        clear_wal(wal_path)
    else:
        # A click may have reached RMS. Retain the WAL and prohibit resubmission.
        wal["phase"] = "UNCERTAIN"
        wal["uncertainSince"] = wal.get("uncertainSince") or iso_utc(now_utc())
        wal["lastObservedExcluded"] = actual_excluded
        write_wal(wal, wal_path)
        state = wal["stateBefore"]
        save_state(state, state_path)
        status = "uncertain"
    evidence = {"status": status, "operationId": wal.get("operationId"), "itemCode": wal["itemCode"],
                "phase": phase, "expectedExcluded": expected_excluded, "actualExcluded": actual_excluded,
                "manualRepairRequired": status == "uncertain"}
    append_audit({"timestamp": iso_utc(now_utc()), "kind": "wal-recovery", **evidence}, audit_path)
    return state, evidence


def recover_wal_with_fresh_readback(state: dict, current: Set[str], state_path: Path, wal_path: Path,
                                    audit_path: Path, exclude_csv: Path) -> Tuple[dict, dict, Set[str]]:
    wal = load_wal(wal_path)
    if wal is None or wal["phase"] in {"PREPARED", "VERIFIED"}:
        recovered, evidence = recover_wal(state, current, state_path, wal_path, audit_path)
        return recovered, evidence, current
    try:
        timeout = max(0, min(180, int(os.environ.get("RPP_WAL_RECOVERY_SECONDS", "180"))))
        interval = max(1, min(30, int(os.environ.get("RPP_WAL_RECOVERY_POLL_SECONDS", "15"))))
    except ValueError as exc:
        raise RuntimeError("WAL recovery timing must be integer seconds") from exc
    deadline = time.monotonic() + timeout
    expected = wal["control"] == "n"
    while True:
        refresh_exclusions(exclude_csv)
        current = legacy.read_current_exclusions(exclude_csv)
        if (wal["itemCode"] in current) == expected or time.monotonic() >= deadline:
            break
        time.sleep(min(interval, max(0, deadline - time.monotonic())))
    recovered, evidence = recover_wal(state, current, state_path, wal_path, audit_path)
    evidence["freshReadback"] = True
    return recovered, evidence, current


def _transition(state_after: dict, code: str, control: str, current: Set[str], execute: bool,
                state_path: Path, wal_path: Path, reservation_id: Optional[str] = None) -> dict:
    action = "OFF" if control == "n" else "ON"
    if not execute:
        return {"itemCode": code, "action": action, "productionChange": False}
    state_before = load_state(state_path)
    operation_id = str(uuid.uuid4())
    wal = {"version": 3, "operationId": operation_id, "phase": "PREPARED", "createdAt": iso_utc(now_utc()),
           "itemCode": code, "control": control, "beforeExcluded": code in current,
           "reservationId": reservation_id, "stateBefore": state_before, "stateAfter": normalize_state(state_after)}
    write_wal(wal, wal_path)
    csv_path = legacy._upload_path(control, code)
    legacy.write_one_row_csv(csv_path, control, code)
    result = legacy.run_adapter(csv_path, control, code, wal_path, operation_id)
    verified_wal = load_wal(wal_path)
    if verified_wal is None or verified_wal.get("phase") != "VERIFIED":
        raise RuntimeError("RMS adapter returned without VERIFIED WAL stage")
    save_state(state_after, state_path)
    clear_wal(wal_path)
    if control == "n":
        current.add(code)
    else:
        current.discard(code)
    return {"itemCode": code, "action": action, "productionChange": True,
            "readback": (result.get("applied") or {}).get("readback")}


def _reservation_state_after(state: dict, reservation: dict, raw_recurring: Set[str]) -> dict:
    next_state = copy.deepcopy(state)
    code = reservation["itemCode"]
    off, override = set(next_state["reservationOff"]), set(next_state["overrideOn"])
    if reservation["action"] == "OFF":
        off.add(code)
        override.discard(code)
    else:
        off.discard(code)
        if code in raw_recurring:
            override.add(code)
        else:
            override.discard(code)
        next_state["owned"] = sorted(set(next_state["owned"]) - {code})
        next_state["preexisting"] = sorted(set(next_state["preexisting"]) - {code})
    next_state["reservationOff"], next_state["overrideOn"] = sorted(off), sorted(override)
    next_state["processedReservations"][reservation["id"]] = {
        "status": "SUCCEEDED", "action": reservation["action"], "itemCode": code,
        "claimId": reservation.get("claimId"), "processedAt": iso_utc(now_utc()),
    }
    return next_state


def process_due_reservations(state: dict, reservations: Iterable[dict], at: dt.datetime, raw_recurring: Set[str], release_allowed: Set[str],
                             current: Set[str], execute: bool, api_base: str, state_path: Path,
                             wal_path: Path, audit_path: Path, max_actions: int = 999) -> Tuple[dict, List[dict], List[dict], List[str]]:
    changes: List[dict] = []
    failures: List[dict] = []
    completed: List[str] = []
    for reservation in reservations:
        if reservation["executeAt"] > at:
            continue
        cached = state["processedReservations"].get(reservation["id"])
        if isinstance(cached, dict) and cached.get("status") == "SUCCEEDED":
            if execute:
                try:
                    acknowledge_reservation(reservation["id"], str(cached.get("claimId") or ""), "SUCCEEDED", api_base=api_base)
                except Exception as exc:
                    failure = {"reservationId": reservation["id"], "error": "success acknowledgement pending: %s" % str(exc)[-500:]}
                    if _must_stop_same_tick(exc):
                        failure["blocksRms"] = True
                        failure["circuitTrip"] = True
                    failures.append(failure)
                    if failure.get("circuitTrip"):
                        break
            continue
        code = reservation["itemCode"]
        next_state = _reservation_state_after(state, reservation, raw_recurring)
        want_off = code in desired_holds(next_state, raw_recurring)
        control = None if (code in current) == want_off else ("n" if want_off else "d")
        # Capacity is based on actual RMS transitions and must be checked before claim.
        if control and len(changes) >= max_actions:
            break
        safe_orphan_restore = (reservation.get("orphaned") is True and reservation["action"] == "ON"
                               and code in set(state["owned"]) and code in set(state["reservationOff"]))
        if reservation.get("orphaned") is True and not safe_orphan_restore:
            failure = {"reservationId": reservation["id"], "itemCode": code, "retryable": False,
                       "error": "孤立ON予約はワーカー所有のOFFと一致しないため実行しません"}
            if execute:
                try:
                    claimed = claim_reservation(reservation["id"], api_base=api_base)
                    claim_id = str(claimed.get("claimId") or "")
                    acknowledge_reservation(reservation["id"], claim_id, "FAILED", failure["error"], api_base)
                    failure["terminal"] = True
                except Exception as exc:
                    failure["retryable"] = True
                    failure["error"] = "orphan guard acknowledgement pending: %s" % str(exc)[-700:]
                    if _must_stop_same_tick(exc):
                        failure["blocksRms"] = True
                        failure["circuitTrip"] = True
            failures.append(failure)
            if failure.get("circuitTrip"):
                break
            continue
        if execute and reservation.get("claimId") and reservation.get("claimExpiresAt") and reservation["claimExpiresAt"] > at:
            failures.append({"reservationId": reservation["id"], "itemCode": code, "retryable": True,
                             "attemptCount": reservation.get("attemptCount"), "nextAttemptAt": reservation.get("nextAttemptAt"),
                             "error": "reservation already has an active claim; skipped"})
            continue
        if reservation["action"] == "ON" and code not in release_allowed:
            # Keep the reservation pending and unclaimed. Once the operator completes
            # every saved target and the snapshot refreshes, the next tick restores ON.
            failure = {"reservationId": reservation["id"], "itemCode": code, "retryable": True,
                       "onGuardBlocked": True,
                       "error": "広告ONには全RPP設定行への目標保存が必要です。保存・スナップショット同期後に自動再試行します"}
            failures.append(failure)
            continue
        if execute:
            try:
                claimed = claim_reservation(reservation["id"], api_base=api_base)
                if (legacy.normalize_code(claimed.get("itemCode")) != reservation["itemCode"]
                        or str(claimed.get("action") or "").upper() != reservation["action"]
                        or parse_iso(claimed.get("executeAt")) != reservation["executeAt"]):
                    raise RuntimeError("claimed reservation did not match fetched reservation")
                reservation = {**reservation, "claimId": str(claimed["claimId"])}
                next_state["processedReservations"][reservation["id"]]["claimId"] = reservation["claimId"]
            except Exception as exc:
                failure = {"reservationId": reservation["id"], "itemCode": code, "retryable": True,
                           "attemptCount": reservation.get("attemptCount"), "nextAttemptAt": reservation.get("nextAttemptAt"),
                           "error": "claim failed: %s" % str(exc)[-900:]}
                if _must_stop_same_tick(exc):
                    failure["blocksRms"] = True
                    failure["circuitTrip"] = True
                failures.append(failure)
                if failure.get("circuitTrip"):
                    break
                continue
        if control == "n":
            next_state["owned"] = sorted(set(next_state["owned"]) | {code})
            next_state["preexisting"] = sorted(set(next_state["preexisting"]) - {code})
        try:
            if control:
                if execute:
                    heartbeat_reservation(reservation["id"], str(reservation.get("claimId") or ""), api_base)
                changes.append(_transition(next_state, code, control, current, execute, state_path, wal_path, reservation["id"]))
            elif execute:
                save_state(next_state, state_path)
            if not execute:
                if want_off:
                    current.add(code)
                else:
                    current.discard(code)
            state = next_state
            completed.append(reservation["id"])
            if execute:
                try:
                    acknowledge_reservation(reservation["id"], str(reservation.get("claimId") or ""), "SUCCEEDED", api_base=api_base)
                except Exception as exc:
                    failure = {"reservationId": reservation["id"], "error": "success acknowledgement pending: %s" % str(exc)[-500:]}
                    if _must_stop_same_tick(exc):
                        failure["blocksRms"] = True
                        failure["circuitTrip"] = True
                    failures.append(failure)
                    if failure.get("circuitTrip"):
                        return state, changes, failures, completed
        except Exception as exc:
            failure = {"reservationId": reservation["id"], "itemCode": code, "retryable": True,
                       "attemptCount": reservation.get("attemptCount"), "nextAttemptAt": reservation.get("nextAttemptAt"),
                       "error": str(exc)[-1000:]}
            wal = load_wal(wal_path)
            if wal is not None and wal["phase"] == "PREPARED":
                state, _ = recover_wal(state, current, state_path, wal_path, audit_path)
                if execute and reservation.get("claimId"):
                    try:
                        release_reservation_claim(reservation["id"], str(reservation["claimId"]), failure["error"], api_base)
                        failure["claimReleased"] = True
                    except Exception as release_exc:
                        failure["claimReleaseError"] = str(release_exc)[-500:]
                        if _must_stop_same_tick(release_exc):
                            failure["blocksRms"] = True
                            failure["circuitTrip"] = True
                failures.append(failure)
                if _must_stop_same_tick(exc) or failure.get("circuitTrip"):
                    failure["blocksRms"] = True
                    failure["circuitTrip"] = True
                    break
                continue
            if wal is not None:
                failure["retryable"] = False
                failure["blocksRms"] = True
                failure["error"] += "; RMS result is uncertain; manual repair required"
            elif _must_stop_same_tick(exc):
                failure["blocksRms"] = True
                failure["circuitTrip"] = True
            failures.append(failure)
            if wal is not None or failure.get("circuitTrip"):
                break
    return state, changes, failures, completed


def reconcile_recurring(state: dict, raw_recurring: Set[str], release_allowed: Set[str], current: Set[str], execute: bool,
                        state_path: Path, wal_path: Path, max_actions: int = 999,
                        audit_path: Path = AUDIT_PATH) -> Tuple[dict, List[dict], List[dict]]:
    next_state = copy.deepcopy(state)
    override = set(next_state["overrideOn"])
    override.intersection_update(raw_recurring)
    next_state["overrideOn"] = sorted(override)
    owned, preexisting = set(next_state["owned"]), set(next_state["preexisting"])
    holds = desired_holds(next_state, raw_recurring)
    changes: List[dict] = []
    failures: List[dict] = []
    for code in sorted(holds | owned | preexisting):
        want_off = code in holds
        try:
            if want_off and code not in current:
                if len(changes) >= max_actions:
                    break
                after = copy.deepcopy(next_state)
                after["owned"] = sorted(owned | {code})
                after["preexisting"] = sorted(preexisting - {code})
                changes.append(_transition(after, code, "n", current, execute, state_path, wal_path))
                next_state, owned, preexisting = after, set(after["owned"]), set(after["preexisting"])
            elif want_off and code in current and code not in owned:
                preexisting.add(code)
                next_state["preexisting"] = sorted(preexisting)
                if execute:
                    save_state(next_state, state_path)
            elif not want_off and code in owned and code in current:
                if len(changes) >= max_actions:
                    break
                if code not in release_allowed:
                    failures.append({"itemCode": code, "retryable": True, "onGuardBlocked": True,
                                     "error": "広告ONには全RPP設定行への目標保存が必要です。保存・スナップショット同期後に自動再試行します"})
                    continue
                after = copy.deepcopy(next_state)
                after["owned"] = sorted(owned - {code})
                after["preexisting"] = sorted(preexisting - {code})
                changes.append(_transition(after, code, "d", current, execute, state_path, wal_path))
                next_state, owned, preexisting = after, set(after["owned"]), set(after["preexisting"])
            elif not want_off:
                owned.discard(code)
                preexisting.discard(code)
                next_state["owned"], next_state["preexisting"] = sorted(owned), sorted(preexisting)
                if execute:
                    save_state(next_state, state_path)
        except Exception as exc:
            failure = {"itemCode": code, "error": str(exc)[-1000:]}
            wal = load_wal(wal_path)
            if wal is not None and wal["phase"] == "PREPARED":
                next_state, _ = recover_wal(next_state, current, state_path, wal_path, audit_path)
                if _must_stop_same_tick(exc):
                    failure["blocksRms"] = True
                    failure["circuitTrip"] = True
            elif wal is not None:
                failure["retryable"] = False
                failure["blocksRms"] = True
                failure["error"] += "; RMS result is uncertain; manual repair required"
            if _must_stop_same_tick(exc):
                failure["blocksRms"] = True
                failure["circuitTrip"] = True
            failures.append(failure)
            if wal_path.exists():
                break
            if failure.get("circuitTrip"):
                break
            continue
    if execute and next_state != state:
        save_state(next_state, state_path)
    return next_state, changes, failures


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        # argparse normally echoes the offending argv to stderr. argv may contain
        # credentials, so route failures through the redacted compact JSON path.
        raise ValueError("invalid CLI arguments")


def build_parser() -> argparse.ArgumentParser:
    parser = SafeArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm")
    parser.add_argument("--api-base", default=API_BASE)
    parser.add_argument("--state", type=Path, default=STATE_PATH)
    parser.add_argument("--wal", type=Path, default=WAL_PATH)
    parser.add_argument("--audit", type=Path, default=AUDIT_PATH)
    parser.add_argument("--circuit", type=Path, default=CIRCUIT_PATH)
    parser.add_argument("--on-guard-alert", type=Path, default=ON_GUARD_ALERT_PATH)
    parser.add_argument("--lock-busy-alert", type=Path, default=LOCK_BUSY_ALERT_PATH)
    parser.add_argument("--exclude-csv", type=Path, default=EXCLUDE_CSV)
    parser.add_argument("--now", help="test-only ISO datetime override")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--reset-circuit", action="store_true")
    parser.add_argument("--circuit-status", action="store_true")
    parser.add_argument("--circuit-probe", action="store_true")
    return parser


def _public_circuit(circuit: dict) -> dict:
    return {key: circuit.get(key) for key in ("open", "category", "signature", "consecutive", "openedAt", "lastFailureAt")}


def emit_compact_cli_failure(args: argparse.Namespace, error_code: str, tick_id: Optional[str] = None) -> None:
    tick_id = tick_id or str(uuid.uuid4())
    try:
        circuit = _public_circuit(load_circuit(args.circuit))
    except Exception:
        circuit = {"open": True, "category": "STATE_CORRUPT", "signature": "STATE_CORRUPT",
                   "consecutive": 1, "openedAt": None, "lastFailureAt": None}
    summary = {
        "schemaVersion": 1,
        "kind": "rppDeliveryTick",
        "tickId": tick_id,
        "ok": False,
        "blocked": True,
        "errorCode": error_code,
        "estimatedTicksRemaining": None,
        "estimatedCompletionMinutes": None,
        "circuitBreaker": circuit,
        "guardBlockedItems": [],
        "auditPath": str(args.audit),
        "audit": {"path": str(args.audit), "tickId": tick_id},
    }
    try:
        append_audit({"timestamp": iso_utc(now_utc()), "event": "scheduler-cli-failure",
                      "tickId": tick_id, "errorCode": error_code, "summary": summary}, args.audit)
    except Exception:
        summary["auditWriteFailed"] = True
    # --quiet suppresses routine/no-change ticks only. Safety failures are never hidden.
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))


def lock_busy_notification_due(path: Path, at: Optional[dt.datetime] = None, interval_seconds: int = 600) -> bool:
    observed_at = (at or now_utc()).astimezone(UTC)
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(path.name + ".lock")
    with lock_path.open("a", encoding="utf-8") as lock_handle:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        try:
            if path.exists():
                try:
                    previous = json.loads(path.read_text(encoding="utf-8"))
                    last_notified = parse_iso(previous.get("lastNotifiedAt"))
                    if 0 <= (observed_at - last_notified).total_seconds() < interval_seconds:
                        return False
                except (OSError, ValueError, RuntimeError, json.JSONDecodeError):
                    pass
            atomic_json_write({"lastNotifiedAt": iso_utc(observed_at)}, path)
            return True
        finally:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)


def clear_lock_busy_alert(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(path.name + ".lock")
    with lock_path.open("a", encoding="utf-8") as lock_handle:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        try:
            if path.exists():
                path.unlink()
                _fsync_parent(path)
        finally:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)


def handle_lock_busy(args: argparse.Namespace) -> int:
    if lock_busy_notification_due(args.lock_busy_alert):
        emit_compact_cli_failure(args, "LOCK_BUSY", args.tick_id)
        return 1
    append_audit({"timestamp": iso_utc(now_utc()), "event": "scheduler-lock-busy-suppressed",
                  "tickId": args.tick_id, "errorCode": "LOCK_BUSY"}, args.audit)
    return 0


def probe_rms_adapter_dom(item_code: str, currently_excluded: bool, directory: Path) -> dict:
    control = "d" if currently_excluded else "n"
    csv_path = directory / "adapter-probe.csv"
    legacy.write_one_row_csv(csv_path, control, item_code)
    env = os.environ.copy()
    env["RPP_ENABLE_RMS_EXCLUSION_UPLOAD"] = "1"
    process = subprocess.run([
        legacy.NODE_BIN, str(legacy.ADAPTER), "--csv", str(csv_path), "--execute",
        "--expected-before=%s" % ("excluded" if currently_excluded else "active"),
    ], cwd=str(legacy.WEB_PROJECT), env=env, text=True, capture_output=True, timeout=600)
    if process.returncode != 0:
        raise RuntimeError((process.stderr or process.stdout or "adapter probe failed").strip()[-3000:])
    try:
        result = json.loads(process.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("RMS adapter probe did not return JSON") from exc
    applied = result.get("applied") if isinstance(result, dict) else None
    if (not isinstance(applied, dict) or result.get("productionChange") is not False
            or applied.get("finalSubmitSkipped") is not True or applied.get("finalUploadButtonPresent") is not True):
        raise RuntimeError("RMS adapter probe did not verify the read-only upload DOM path")
    return {"itemCode": item_code, "currentlyExcluded": currently_excluded,
            "searchReadbackCount": len(applied.get("beforeReadback") or []),
            "uploadDomVerified": True, "productionChange": False}


def probe_external_dependencies(args: argparse.Namespace) -> dict:
    schedules, reservations, release_allowed, orphaned = fetch_delivery_schedules(args.api_base)
    legacy_codes = legacy.fetch_selection(args.api_base)
    with tempfile.TemporaryDirectory(prefix="rpp-circuit-probe-") as temporary:
        output = Path(temporary) / "exclude.csv"
        receipt = refresh_exclusions(output)
        exclusions = legacy.read_current_exclusions(output)
        candidates = sorted({row["itemCode"] for row in schedules} | {legacy.normalize_code(code) for code in legacy_codes})
        if not candidates:
            raise RuntimeError("RMS adapter probe requires at least one authoritative product")
        adapter_probe = probe_rms_adapter_dom(candidates[0], candidates[0] in exclusions, Path(temporary))
    return {"scheduleCount": len(schedules), "pendingReservationCount": len(reservations),
            "releaseAllowedCount": len(release_allowed), "orphanCount": len(orphaned),
            "legacySelectionCount": len(legacy_codes), "exclusionCount": len(exclusions),
            "snapshotExpectedCount": (receipt.get("exclude") or {}).get("expected_count"),
            "adapterProbe": adapter_probe}


def recover_wal_while_circuit_open(args: argparse.Namespace) -> dict:
    state = load_state(args.state)
    wal = load_wal(args.wal)
    if wal is not None and wal["phase"] == "PREPARED":
        state, evidence = recover_wal(state, set(), args.state, args.wal, args.audit)
        return evidence
    refresh_exclusions(args.exclude_csv)
    current = legacy.read_current_exclusions(args.exclude_csv)
    _, evidence, _ = recover_wal_with_fresh_readback(
        state, current, args.state, args.wal, args.audit, args.exclude_csv)
    append_audit({"timestamp": iso_utc(now_utc()), "kind": "circuit-open-wal-recovery", **evidence}, args.audit)
    return evidence


def run(args: argparse.Namespace) -> dict:
    at = parse_iso(args.now) if args.now else now_utc()
    tick_id = getattr(args, "tick_id", None) or str(uuid.uuid4())
    action_limit = max_actions_per_tick()
    schedules, reservations, release_allowed, orphaned = fetch_delivery_schedules(args.api_base)
    legacy_codes = legacy.fetch_selection(args.api_base)
    stored_version = None
    if args.state.exists():
        try:
            stored_payload = json.loads(args.state.read_text(encoding="utf-8"))
            stored_version = stored_payload.get("version") if isinstance(stored_payload, dict) else None
        except (OSError, json.JSONDecodeError):
            stored_version = None
    state = load_state(args.state)
    recovery = {"status": "not-applicable"}
    if args.execute:
        if stored_version != STATE_VERSION:
            save_state(state, args.state)
        state = migrate_legacy_ledger(state, args.state)
        existing_wal = load_wal(args.wal)
        if existing_wal is not None and existing_wal["phase"] == "PREPARED":
            state, recovery = recover_wal(state, set(), args.state, args.wal, args.audit)
    raw_recurring = recurring_holds(at, schedules, legacy_codes)
    preview_state = copy.deepcopy(state)
    preview_state["overrideOn"] = sorted(set(preview_state["overrideOn"]) & raw_recurring)
    preview_holds = desired_holds(preview_state, raw_recurring)
    unprocessed_due = [
        row for row in reservations
        if row["executeAt"] <= at
        and not (
            isinstance(state["processedReservations"].get(row["id"]), dict)
            and state["processedReservations"][row["id"]].get("status") == "SUCCEEDED"
        )
    ]
    drift_check_due = bool(state["owned"]) and at - parse_iso(state["lastRmsSnapshotAt"]) >= dt.timedelta(minutes=15)
    needs_snapshot = bool(
        args.wal.exists()
        or unprocessed_due
        or (preview_holds - set(state["owned"]) - set(state["preexisting"]))
        or (set(state["owned"]) - preview_holds)
        or drift_check_due
    )
    if args.execute and needs_snapshot:
        refresh_exclusions(args.exclude_csv)
        state["lastRmsSnapshotAt"] = iso_utc(at)
        save_state(state, args.state)
    current = legacy.read_current_exclusions(args.exclude_csv)
    if args.execute and args.wal.exists():
        state, recovery, current = recover_wal_with_fresh_readback(
            state, current, args.state, args.wal, args.audit, args.exclude_csv)
        if recovery.get("status") == "uncertain":
            warning = "RMS結果がUNCERTAINです。再送せず手動確認・修復してください: %s" % recovery.get("itemCode")
            summary = {"tickId": tick_id, "observedAt": iso_utc(at), "ok": False, "dryRun": False, "activeRecurring": sorted(raw_recurring),
                       "desiredOff": sorted(desired_holds(state, raw_recurring)), "completedReservations": [],
                       "changes": [], "failures": [{"itemCode": recovery.get("itemCode"), "error": warning,
                                                       "retryable": False, "blocksRms": True}],
                       "ownedAfter": state["owned"], "preexistingAfter": state["preexisting"],
                       "walRecovery": recovery, "maxActionsPerTick": action_limit,
                       "queueDepth": 1, "blocked": True, "estimatedTicksRemaining": None,
                       "estimatedCompletionMinutes": None, "guardBlockedItems": [], "warnings": [warning]}
            return summary
    if args.execute and not args.wal.exists():
        pruned_state = prune_state_history(state, reservations, at)
        if pruned_state != state:
            state = pruned_state
            save_state(state, args.state)
    state_before_queue = copy.deepcopy(state)
    queue_schedules = list(schedules) + [
        {"itemCode": legacy.normalize_code(code), "enabled": True, "startTime": "01:30", "endTime": "06:00"}
        for code in legacy_codes
    ]
    state, occurrence_warnings = sync_occurrence_queue(state, queue_schedules, at)
    if args.execute and state != state_before_queue:
        save_state(state, args.state)
    state, reservation_changes, reservation_failures, completed = process_due_reservations(
        state, reservations, at, raw_recurring, release_allowed, current, args.execute, args.api_base, args.state, args.wal, args.audit, action_limit)
    recurring_changes: List[dict] = []
    recurring_failures: List[dict] = []
    rms_blocked = any(item.get("blocksRms") for item in reservation_failures)
    if not rms_blocked and (not args.execute or needs_snapshot):
        state, recurring_changes, recurring_failures = reconcile_recurring(
            state, raw_recurring, release_allowed, current, args.execute, args.state, args.wal,
            max(0, action_limit - len(reservation_changes)), args.audit)
    settled_state = settle_occurrence_queue(state, current, at)
    if args.execute and settled_state != state:
        save_state(settled_state, args.state)
    state = settled_state
    final_holds = desired_holds(state, raw_recurring)
    deferred_reservations = len([row for row in unprocessed_due if row["id"] not in completed])
    remaining_recurring = len((final_holds - current) | ((set(state["owned"]) - final_holds) & current))
    queue_depth = deferred_reservations + remaining_recurring
    guard_blocked_items = sorted({
        row["itemCode"] for row in unprocessed_due
        if row.get("action") == "ON" and row["itemCode"] not in release_allowed
    } | {
        code for code in set(state["owned"])
        if code not in final_holds and code in current and code not in release_allowed
    })
    blocked = rms_blocked or bool(guard_blocked_items)
    estimated_ticks = None if blocked else (int(math.ceil(queue_depth / action_limit)) if queue_depth else 0)
    orphan_warnings = (["孤立した時間指定を実行対象から隔離: %s" % ",".join(sorted(orphaned))] if orphaned else [])
    warnings = occurrence_warnings + orphan_warnings + (["処理待ち %d件。次回の1分実行で継続します" % queue_depth] if queue_depth else [])
    summary = {"tickId": tick_id, "observedAt": iso_utc(at), "ok": not reservation_failures and not recurring_failures, "dryRun": not args.execute,
               "activeRecurring": sorted(raw_recurring), "desiredOff": sorted(final_holds),
               "completedReservations": completed, "changes": reservation_changes + recurring_changes,
               "failures": reservation_failures + recurring_failures, "ownedAfter": state["owned"],
               "preexistingAfter": state["preexisting"], "walRecovery": recovery,
               "occurrenceQueue": state["occurrenceQueue"], "maxActionsPerTick": action_limit,
               "queueDepth": queue_depth, "estimatedTicksRemaining": estimated_ticks,
               "estimatedCompletionMinutes": estimated_ticks, "blocked": blocked,
               "guardBlockedItems": guard_blocked_items,
               "rolloutPolicy": {"mode": "BOUNDED_CANARY", "maxActionsPerTick": action_limit},
               "warnings": warnings}
    return summary


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    args.tick_id = str(uuid.uuid4())
    legacy.load_env_file(legacy.ENV_FILE)
    if args.circuit_status:
        if not args.quiet:
            print(json.dumps({"ok": True, "circuitBreaker": _public_circuit(load_circuit(args.circuit)),
                              "walPresent": args.wal.exists()}, ensure_ascii=False, sort_keys=True))
        return 0
    if args.reset_circuit:
        if os.environ.get("RPP_ENABLE_PRODUCT_DELIVERY_SCHEDULER") != "1" or args.confirm != CIRCUIT_RESET_CONFIRMATION:
            raise RuntimeError("--confirm=%s and production gate are required" % CIRCUIT_RESET_CONFIRMATION)
        if args.wal.exists():
            raise RuntimeError("WAL exists; circuit reset is prohibited until WAL recovery completes")
        if load_circuit(args.circuit).get("open") is True:
            raise RuntimeError("OPEN circuit cannot be reset directly; use --circuit-probe so the read-only adapter path is verified")
        reset_circuit(args.circuit)
        if not args.quiet:
            print(json.dumps({"ok": True, "circuitBreaker": {"open": False}, "message": "circuit breaker reset"}, sort_keys=True))
        return 0
    if args.circuit_probe:
        if os.environ.get("RPP_ENABLE_PRODUCT_DELIVERY_SCHEDULER") != "1" or args.confirm != CIRCUIT_PROBE_CONFIRMATION:
            raise RuntimeError("--confirm=%s and production gate are required" % CIRCUIT_PROBE_CONFIRMATION)
        if args.wal.exists():
            raise RuntimeError("WAL exists; dependency probe is prohibited until WAL recovery completes")
        probe_lock = legacy.acquire_global_lock()
        if probe_lock is None:
            return handle_lock_busy(args)
        clear_lock_busy_alert(args.lock_busy_alert)
        try:
            result = probe_external_dependencies(args)
            reset_circuit(args.circuit)
            if not args.quiet:
                print(json.dumps({"ok": True, "probeOnly": True, "productionChange": False,
                                  "circuitBreaker": {"open": False}, "readback": result}, ensure_ascii=False, sort_keys=True))
            return 0
        finally:
            legacy.release_global_lock(probe_lock)

    require_gate(args.execute, args.confirm, os.environ)
    lock_fd = None
    if args.execute:
        lock_fd = legacy.acquire_global_lock()
        if lock_fd is None:
            return handle_lock_busy(args)
        clear_lock_busy_alert(args.lock_busy_alert)
    try:
        if args.execute and load_circuit(args.circuit).get("open") is True:
            if args.wal.exists():
                try:
                    recover_wal_while_circuit_open(args)
                except Exception as error:
                    append_audit({"timestamp": iso_utc(now_utc()), "kind": "circuit-open-wal-recovery-failed",
                                  "error": str(error)[-500:]}, args.audit)
            # The opening tick emitted the alert. OPEN ticks never call schedule API,
            # claim, or RMS writes; WAL recovery above is read-only.
            return 0
        try:
            summary = run(args)
        except Exception as error:
            if not args.execute:
                raise
            circuit = record_external_failure(error, args.circuit)
            if circuit.get("status") == "ignored":
                summary = {"tickId": args.tick_id, "observedAt": iso_utc(now_utc()), "ok": False,
                           "dryRun": False, "changes": [], "failures": [{"error": str(error)[-1000:]}],
                           "completedReservations": [], "activeRecurring": [], "desiredOff": [],
                           "ownedAfter": [], "preexistingAfter": [], "queueDepth": 0, "blocked": True,
                           "maxActionsPerTick": max_actions_per_tick(), "walRecovery": {"status": "unknown"},
                           "circuitBreaker": _public_circuit(load_circuit(args.circuit)), "warnings": []}
                append_audit({"timestamp": iso_utc(now_utc()), "kind": "tick", **summary}, args.audit)
                if not args.quiet:
                    print(json.dumps(notification_summary(summary, args.audit), ensure_ascii=False, sort_keys=True))
                return 1
            public_circuit = _public_circuit(circuit)
            error_summary = {"tickId": args.tick_id, "observedAt": iso_utc(now_utc()), "ok": False,
                             "dryRun": False, "changes": [], "failures": [{"error": str(error)[-1000:], "blocksRms": True}],
                             "completedReservations": [], "activeRecurring": [], "desiredOff": [],
                             "ownedAfter": [], "preexistingAfter": [], "queueDepth": 0, "blocked": True,
                             "maxActionsPerTick": max_actions_per_tick(), "walRecovery": {"status": "not-applicable"},
                             "circuitBreaker": public_circuit, "warnings": []}
            append_audit({"timestamp": iso_utc(now_utc()), "kind": "tick", **error_summary}, args.audit)
            if not args.quiet and (circuit.get("notify") or not circuit.get("open")):
                print(json.dumps(notification_summary(error_summary, args.audit), ensure_ascii=False, sort_keys=True))
            return 1 if circuit.get("notify") or not circuit.get("open") else 0

        if args.execute:
            external_failure = next((row for row in summary.get("failures", []) if _failure_category(row.get("error", ""))), None)
            if external_failure:
                circuit = record_external_failure(external_failure.get("error", ""), args.circuit)
            else:
                reset_circuit(args.circuit)
                circuit = {"open": False, "category": None, "signature": None, "consecutive": 0,
                           "openedAt": None, "lastFailureAt": None}
            public_circuit = _public_circuit(circuit)
            summary["circuitBreaker"] = public_circuit
            guard_codes = set(summary.get("guardBlockedItems", []))
            guard_alert = update_on_guard_alerts(guard_codes, args.on_guard_alert)
            summary["onGuardBlocks"] = guard_alert
            if circuit.get("open"):
                summary.setdefault("warnings", []).append("同一の外部障害が継続したためworkerを自動停止しました。原因修復後にread-only probeが必要です")
                append_audit({"timestamp": iso_utc(now_utc()), "kind": "circuit-breaker", **public_circuit}, args.audit)
            if summary.get("changes") or summary.get("failures") or summary.get("completedReservations") or summary.get("warnings") or summary.get("walRecovery", {}).get("status") not in {"none", "not-applicable"}:
                append_audit({"timestamp": iso_utc(now_utc()), "kind": "tick", **summary}, args.audit)
            only_guard_failures = bool(summary.get("failures")) and all(row.get("onGuardBlocked") for row in summary["failures"])
            emit = bool(summary.get("changes") or summary.get("completedReservations") or summary.get("warnings") or summary.get("failures"))
            if only_guard_failures:
                emit = bool(guard_alert.get("notify") or summary.get("changes") or summary.get("completedReservations"))
            if not args.quiet and emit:
                notification_source = copy.deepcopy(summary)
                if not guard_alert.get("notify"):
                    notification_source["failures"] = [row for row in notification_source["failures"] if not row.get("onGuardBlocked")]
                print(json.dumps(notification_summary(notification_source, args.audit), ensure_ascii=False, sort_keys=True))
            if only_guard_failures and not guard_alert.get("notify"):
                return 0
            return 0 if summary["ok"] else 1

        if not args.quiet and (summary["changes"] or summary["failures"] or summary["completedReservations"] or summary["warnings"]):
            print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
        return 0 if summary["ok"] else 1
    finally:
        if lock_fd is not None:
            legacy.release_global_lock(lock_fd)


def cli(argv: Optional[List[str]] = None) -> int:
    try:
        return main(argv)
    except Exception as error:
        # Never include the raw exception: upstream responses or argv may contain secrets.
        try:
            args, _ = build_parser().parse_known_args(argv)
        except BaseException:
            args = argparse.Namespace(audit=AUDIT_PATH, circuit=CIRCUIT_PATH, quiet=False)
        emit_compact_cli_failure(args, _failure_category(error) or type(error).__name__.upper())
        return 1


if __name__ == "__main__":
    raise SystemExit(cli())
