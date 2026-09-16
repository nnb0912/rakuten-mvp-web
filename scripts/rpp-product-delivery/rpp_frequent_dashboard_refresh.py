#!/usr/bin/env python3
"""Frequent read-only RPP refresh and Render dashboard sync."""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

PROJECT = Path("/Users/nob/Projects/rpp-8am-notify")
LOG_DIR = PROJECT / "rpp_logs"
LOCK_PATH = Path("/tmp/rise-rpp-data-refresh.lock")
TARGETS_PATH = PROJECT / "rpp_targets" / "rpp_alert_targets.json"
POSITION_LOG = PROJECT / "rpp_position_adjustment_log.json"
API_BASE = os.environ.get("RPP_DASHBOARD_URL", "https://rakuten-mvp-web.onrender.com").rstrip("/")
PYTHON = "/usr/bin/python3"
SETTINGS_SCRIPT = os.environ.get("RPP_SETTINGS_REFRESH_SCRIPT", str(PROJECT / "scripts_refresh_rpp_settings_csvs.py"))
SNAPSHOT_SENDER = os.environ.get("RPP_SNAPSHOT_SENDER", "/Users/nob/.hermes/scripts/rpp_push_dashboard_snapshot.py")
RECOMMENDATION_SCRIPT = os.environ.get("RPP_RECOMMENDATION_SCRIPT", str(PROJECT / "rpp_auto_recommendations.js"))
POSITION_MONITOR_SCRIPT = os.environ.get("RPP_POSITION_MONITOR_SCRIPT", str(PROJECT / "rpp_position_monitor.js"))
BUDGET_OBSERVATION = PROJECT / "rpp_budget_observation.json"


def run_stage(name: str, command: list[str], timeout: int, env: dict[str, str] | None = None) -> dict:
    started = time.monotonic()
    result = subprocess.run(command, cwd=PROJECT, text=True, capture_output=True, timeout=timeout, env=env)
    return {
        "name": name,
        "ok": result.returncode == 0,
        "code": result.returncode,
        "seconds": round(time.monotonic() - started, 1),
        "stdout": result.stdout[-4000:],
        "stderr": result.stderr[-4000:],
    }


def initialize_budget_unknown() -> None:
    """Invalidate the previous budget before imports/browser work can fail."""
    attempted_at = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    payload = {
        "version": 1, "status": "UNKNOWN", "attemptedAt": attempted_at,
        "observedAt": None, "asOfDate": None, "source": "RMS_RPP_TOP_AND_CAMPAIGNS",
        "currency": "JPY", "campaignCount": None, "activeCampaignCount": None,
        "effectiveBudget": None, "continuingBudget": None,
        "activeCampaignBudgetTotal": None, "allCampaignBudgetTotal": None,
        "complete": False,
    }
    BUDGET_OBSERVATION.parent.mkdir(parents=True, exist_ok=True)
    tmp = BUDGET_OBSERVATION.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(BUDGET_OBSERVATION)


def sync_token() -> str:
    value = os.environ.get("RPP_SNAPSHOT_SYNC_TOKEN", "").strip()
    if value:
        return value
    result = subprocess.run(
        ["security", "find-generic-password", "-s", "hermes.rpp.snapshot-sync", "-w"],
        text=True, capture_output=True,
    )
    if result.returncode or not result.stdout.strip():
        raise RuntimeError("RPP snapshot sync token is unavailable")
    return result.stdout.strip()


def refresh_targets() -> dict:
    started = time.monotonic()
    req = urllib.request.Request(
        f"{API_BASE}/api/rpp/sync-snapshot?resource=targets",
        headers={"Authorization": f"Bearer {sync_token()}", "Accept": "application/json", "User-Agent": "rise-rpp-position-sync/1.0"},
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        data = json.load(response)
    targets = data.get("targets")
    if not data.get("ok") or not isinstance(targets, list) or not targets:
        raise RuntimeError("machine target export returned no targets")
    payload = {"updatedAt": data.get("updatedAt"), "source": f"{API_BASE}/api/rpp/sync-snapshot?resource=targets", "targets": targets}
    TARGETS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = TARGETS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(TARGETS_PATH)
    readback = json.loads(TARGETS_PATH.read_text(encoding="utf-8"))
    if len(readback.get("targets", [])) != len(targets):
        raise RuntimeError("target file readback count mismatch")
    return {"name": "target_sync", "ok": True, "count": len(targets), "seconds": round(time.monotonic() - started, 1)}


def append_positions(raw_path: Path) -> dict:
    rows = json.loads(raw_path.read_text(encoding="utf-8"))
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("position monitor returned no rows")
    timestamp = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    adjustments = []
    measured = 0
    errors = 0
    for row in rows:
        pc = row.get("pc") or {}
        mobile = row.get("mobile") or {}
        if pc.get("error") or mobile.get("error"):
            errors += 1
        else:
            measured += 1
        adj = {
            "itemCode": row.get("itemCode"),
            "keyword": row.get("sourceKeyword") or row.get("keyword"),
            "searchKeyword": row.get("keyword"),
            "targetId": row.get("targetId"),
            "owner": row.get("owner"),
            "action": "MEASURE",
            "actionJa": "測定のみ",
        }
        for prefix, device in (("pc", pc), ("mobile", mobile)):
            adj[f"{prefix}Measured"] = not bool(device.get("error"))
            adj[f"{prefix}ScreenPosition"] = device.get("screenPosition")
            adj[f"{prefix}OrganicPosition"] = device.get("organicPosition")
            adj[f"{prefix}RppAdPosition"] = device.get("rppAdPosition")
            adj[f"{prefix}HasRppSlot"] = device.get("hasRppSlot")
            adj[f"{prefix}CardsParsed"] = device.get("cardsParsed")
            adj[f"{prefix}PrCardsParsed"] = device.get("prCardsParsed")
        adjustments.append(adj)
    history = json.loads(POSITION_LOG.read_text(encoding="utf-8")) if POSITION_LOG.exists() else []
    if not isinstance(history, list):
        history = history.get("entries", [])
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=10)
    kept = []
    for entry in history:
        try:
            when = dt.datetime.fromisoformat(str(entry.get("timestamp", "")).replace("Z", "+00:00"))
            if when >= cutoff:
                kept.append(entry)
        except Exception:
            continue
    kept.append({"timestamp": timestamp, "adjustments": adjustments})
    tmp = POSITION_LOG.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(kept, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(POSITION_LOG)
    check = json.loads(POSITION_LOG.read_text(encoding="utf-8"))[-1]
    if len(check.get("adjustments", [])) != len(adjustments):
        raise RuntimeError("position log readback count mismatch")
    return {"name": "position_readback", "ok": True, "rows": len(rows), "measured": measured, "errors": errors, "timestamp": timestamp}


def hourly() -> list[dict]:
    stages = []
    initialize_budget_unknown()
    settings = run_stage("settings", [PYTHON, SETTINGS_SCRIPT], 900)
    stages.append(settings)
    if not settings["ok"]:
        stages.append({"name": "recommendations", "ok": False, "skipped": "settings failed"})
        stages.append(run_stage("dashboard_sync", [PYTHON, SNAPSHOT_SENDER, "--failure-reason=settings_failed"], 120))
        return stages
    recommendations = run_stage("recommendations", ["node", RECOMMENDATION_SCRIPT, "--no-target-sync"], 180)
    stages.append(recommendations)
    sender_args = [PYTHON, SNAPSHOT_SENDER] if recommendations["ok"] else [PYTHON, SNAPSHOT_SENDER, "--failure-reason=recommendations_failed"]
    stages.append(run_stage("dashboard_sync", sender_args, 120))
    return stages


def positions() -> list[dict]:
    stages = []
    try:
        stages.append(refresh_targets())
    except Exception as error:
        stages.append({"name": "target_sync", "ok": False, "error": str(error)})
        stages.append(run_stage("dashboard_sync", [PYTHON, SNAPSHOT_SENDER, "--failure-reason=positions_failed"], 120))
        return stages
    with tempfile.NamedTemporaryFile(prefix="rpp_positions_", suffix=".json", delete=False) as handle:
        raw = Path(handle.name)
    env = os.environ.copy()
    env.update({"RPP_RENDER_WAIT_MS": "1200", "RPP_TARGET_PAUSE_MIN_MS": "1500", "RPP_TARGET_PAUSE_MAX_MS": "4000"})
    monitor = run_stage("position_monitor", ["node", POSITION_MONITOR_SCRIPT, f"--targets={TARGETS_PATH}", f"--out={raw}"], 3000, env)
    stages.append(monitor)
    if not monitor["ok"]:
        raw.unlink(missing_ok=True)
        stages.append(run_stage("dashboard_sync", [PYTHON, SNAPSHOT_SENDER, "--failure-reason=positions_failed"], 120))
        return stages
    try:
        readback = append_positions(raw)
        stages.append(readback)
    except Exception as error:
        raw.unlink(missing_ok=True)
        stages.append({"name": "position_readback", "ok": False, "error": str(error)})
        stages.append(run_stage("dashboard_sync", [PYTHON, SNAPSHOT_SENDER, "--failure-reason=positions_failed"], 120))
        return stages
    raw.unlink(missing_ok=True)
    recommendations = run_stage("recommendations", ["node", RECOMMENDATION_SCRIPT, "--no-target-sync"], 180)
    stages.append(recommendations)
    sender_args = [PYTHON, SNAPSHOT_SENDER] if recommendations["ok"] else [PYTHON, SNAPSHOT_SENDER, "--failure-reason=recommendations_failed"]
    stages.append(run_stage("dashboard_sync", sender_args, 120))
    return stages


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("hourly", "positions"))
    parser.add_argument("--report", action="store_true")
    args = parser.parse_args()
    LOG_DIR.mkdir(exist_ok=True)
    with LOCK_PATH.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if args.report:
                print(json.dumps({"ok": True, "skipped": "another RPP refresh is running"}, ensure_ascii=False))
            return 0
        started_at = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
        try:
            stages = hourly() if args.mode == "hourly" else positions()
        except Exception as error:
            stages = [{"name": "orchestrator", "ok": False, "error": str(error)}]
        result = {"mode": args.mode, "startedAt": started_at, "finishedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"), "ok": all(x.get("ok") for x in stages), "stages": stages}
        receipt = LOG_DIR / f"rpp_{args.mode}_refresh_{dt.datetime.now():%Y%m%d_%H%M%S}.json"
        receipt.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if args.report or not result["ok"]:
            summary = {"ok": result["ok"], "mode": args.mode, "receipt": str(receipt), "stages": [{k: v for k, v in row.items() if k not in {"stdout", "stderr"}} for row in stages]}
            print(json.dumps(summary, ensure_ascii=False))
        return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
