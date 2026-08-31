#!/usr/bin/env python3
"""Push the latest local RPP dashboard snapshot to Render."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

PROJECT = Path(os.environ.get("RPP_PROJECT_DIR", "/Users/nob/Projects/rpp-8am-notify"))
API_BASE = os.environ.get("RPP_DASHBOARD_URL", "https://rakuten-mvp-web.onrender.com").rstrip("/")
FILES = [
    "rpp_keyword_settings.csv",
    "rpp_item_settings.csv",
    "rpp_exclude_items.csv",
    "rpp_keyword_reports.csv",
    "rpp_item_reports.csv",
    "rpp_item_reports_7d.csv",
    "rpp_position_adjustment_log.json",
]


def token() -> str:
    value = os.environ.get("RPP_SNAPSHOT_SYNC_TOKEN", "").strip()
    if value:
        return value
    result = subprocess.run(
        ["security", "find-generic-password", "-s", "hermes.rpp.snapshot-sync", "-w"],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError("RPP snapshot sync token is not configured")
    return result.stdout.strip()


def latest_recommendation() -> tuple[Path, dict]:
    candidates = sorted((PROJECT / "rpp_recommendations").glob("rpp_auto_recommendations_????????.json"))
    if not candidates:
        raise RuntimeError("RPP recommendation JSON was not found")
    path = candidates[-1]
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data.get("recommendations"), list):
        raise RuntimeError(f"invalid recommendation JSON: {path}")
    return path, data


def file_rows() -> list[dict]:
    rows = []
    for name in FILES:
        path = PROJECT / name
        exists = path.exists()
        rows.append({
            "name": name,
            "exists": exists,
            "mtime": dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc).isoformat().replace("+00:00", "Z") if exists else None,
            "size": path.stat().st_size if exists else 0,
        })
    return rows


def cron_status() -> dict:
    logs = sorted((PROJECT / "rpp_logs").glob("rpp_morning_chatwork_notify_????????_??????.log"), key=lambda p: p.stat().st_mtime)
    if not logs:
        return {"ok": False, "status": "未実行", "logFile": None, "mtime": None, "okParts": 0, "failedParts": 0, "warnings": 0, "sent": False, "dryRun": False}
    path = logs[-1]
    text = path.read_text(encoding="utf-8", errors="replace")
    failed = text.count("FAILED ") + text.count("ERROR ")
    sent = "RPP morning notify completed" in text or "まとめて1通送信しました" in text
    dry = "DRY RUN completed" in text
    return {
        "ok": failed == 0 and sent,
        "status": "成功" if failed == 0 and sent else "ドライラン" if dry else "失敗あり" if failed else "実行中/未送信",
        "logFile": path.name,
        "mtime": dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "okParts": text.count("] OK "),
        "failedParts": failed,
        "warnings": text.count("WARN "),
        "sent": sent,
        "dryRun": dry,
    }


def request(method: str, auth: str, payload: dict | None = None) -> tuple[int, dict]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        f"{API_BASE}/api/rpp/sync-snapshot",
        data=body,
        method=method,
        headers={"Authorization": f"Bearer {auth}", "Content-Type": "application/json", "User-Agent": "rise-rpp-snapshot-sync/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try:
            detail = json.load(error)
        except Exception:
            detail = {"error": error.read().decode("utf-8", "replace")[:500]}
        return error.code, detail


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    source, recommendations = latest_recommendation()
    payload = {
        "syncedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "recommendations": recommendations,
        "latestFiles": file_rows(),
        "cronStatus": cron_status(),
    }
    summary = {"source": source.name, "recommendations": len(recommendations["recommendations"]), "files": len(payload["latestFiles"]), "dryRun": args.dry_run}
    if args.dry_run:
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    auth = token()
    status, posted = request("POST", auth, payload)
    if status != 201 or not posted.get("ok"):
        raise RuntimeError(f"snapshot POST failed: HTTP {status} {posted.get('error', 'unknown error')}")
    read_status, readback = request("GET", auth)
    snapshot = readback.get("snapshot") or {}
    expected_at = dt.datetime.fromisoformat(payload["syncedAt"].replace("Z", "+00:00"))
    actual_value = snapshot.get("syncedAt")
    actual_at = dt.datetime.fromisoformat(actual_value.replace("Z", "+00:00")) if isinstance(actual_value, str) else None
    if read_status != 200 or actual_at is None or abs((actual_at - expected_at).total_seconds()) >= 0.001:
        raise RuntimeError(f"snapshot readback mismatch: HTTP {read_status}")
    print(json.dumps({**summary, "dryRun": False, "syncedAt": payload["syncedAt"], "readback": "OK"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
