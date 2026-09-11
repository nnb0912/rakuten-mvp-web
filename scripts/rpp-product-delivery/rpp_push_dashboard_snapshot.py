#!/usr/bin/env python3
"""Push the latest local RPP dashboard snapshot to Render."""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROJECT = Path(os.environ.get("RPP_PROJECT_DIR", "/Users/nob/Projects/rpp-8am-notify"))
OWNER_MAP_PATH = Path(os.environ.get("RPP_OWNER_MAP_PATH", "/Users/nob/Projects/rakuten-mvp-web/src/data/rpp_owner_map.json"))
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


def _read_cp932_csv(name: str) -> list[dict[str, str]]:
    path = PROJECT / name
    with path.open("r", encoding="cp932", errors="strict", newline="") as handle:
        return list(csv.DictReader(handle))


def _positive_number(value: object) -> float | None:
    try:
        parsed = float(str(value or "").replace(",", "").strip())
        return parsed if parsed > 0 else None
    except ValueError:
        return None


def _target_id(item_code: str, keyword: str) -> str:
    safe = "-_.!~*'()"
    return "__".join(urllib.parse.quote(part, safe=safe) for part in (item_code.lower(), keyword))


def operational_data() -> dict:
    raw_owner_map = json.loads(OWNER_MAP_PATH.read_text(encoding="utf-8"))
    owner_map = {str(code).strip().lower(): str(owner).strip() for code, owner in (raw_owner_map.get("owners") or raw_owner_map).items()}
    owner_for = lambda code: owner_map.get(code, "担当未設定") or "担当未設定"
    item_rows = _read_cp932_csv("rpp_item_settings.csv")
    keyword_rows = _read_cp932_csv("rpp_keyword_settings.csv")
    exclude_rows = _read_cp932_csv("rpp_exclude_items.csv")
    excluded = {str(row.get("商品管理番号") or "").strip().lower() for row in exclude_rows}
    excluded.discard("")
    item_map: dict[str, dict] = {}
    configured: list[dict] = []
    all_configured: list[dict] = []
    product_map: dict[str, dict] = {}
    for row in item_rows:
        code = str(row.get("商品管理番号") or "").strip().lower()
        cpc = _positive_number(row.get("商品CPC"))
        if not code or cpc is None:
            continue
        name = str(row.get("商品名") or "").strip()
        is_excluded = code in excluded or str(row.get("除外登録済み商品") or "").strip().lower() == "yes"
        item_map[code] = {"itemName": name, "itemCpc": cpc, "excluded": is_excluded}
        product_map[code] = {"itemCode": code, "itemName": name, "itemCpc": cpc, "excluded": is_excluded, "owner": owner_for(code)}
        target = {"id": _target_id(code, "商品CPC"), "itemCode": code, "itemName": name, "keyword": "商品CPC", "itemCpc": cpc, "keywordCpc": None, "source": "商品CPC", "owner": owner_for(code)}
        all_configured.append(target)
        if not is_excluded:
            configured.append(target)
    for row in keyword_rows:
        code = str(row.get("商品管理番号") or "").strip().lower()
        keyword = str(row.get("キーワード") or "").strip()
        keyword_cpc = _positive_number(row.get("キーワードCPC"))
        if not code or not keyword or keyword_cpc is None:
            continue
        item = item_map.get(code, {})
        is_excluded = code in excluded or bool(item.get("excluded"))
        name = str(row.get("商品名") or item.get("itemName") or "").strip()
        product_map.setdefault(code, {"itemCode": code, "itemName": name, "itemCpc": item.get("itemCpc"), "excluded": is_excluded, "owner": owner_for(code)})
        target = {"id": _target_id(code, keyword), "itemCode": code, "itemName": name, "keyword": keyword, "itemCpc": item.get("itemCpc"), "keywordCpc": keyword_cpc, "source": "キーワードCPC", "owner": owner_for(code)}
        all_configured.append(target)
        if not is_excluded:
            configured.append(target)
    for code in excluded:
        product_map.setdefault(code, {"itemCode": code, "itemName": "", "itemCpc": None, "excluded": True, "owner": owner_for(code)})
    configured.sort(key=lambda row: (row["itemCode"], row["keyword"]))
    all_configured.sort(key=lambda row: (row["itemCode"], row["keyword"]))
    products = sorted(product_map.values(), key=lambda row: row["itemCode"])
    owners = sorted({owner for owner in owner_map.values() if owner and owner != "なし"})
    return {"configuredTargets": configured, "allConfiguredTargets": all_configured, "exclusionProducts": products, "owners": owners}


def _number(value: object) -> float:
    try:
        return float(str(value or "0").replace(",", ""))
    except ValueError:
        return 0.0


def budget_metrics() -> dict | None:
    path = PROJECT / "rpp_item_reports_7d.csv"
    if not path.exists():
        return None
    with path.open("r", encoding="cp932", errors="replace", newline="") as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        return None
    spend = sum(_number(row.get("実績額(合計)")) for row in rows)
    sales = sum(_number(row.get("売上金額(合計720時間)")) for row in rows)
    clicks = sum(_number(row.get("クリック数(合計)")) for row in rows)
    orders = sum(_number(row.get("売上件数(合計720時間)")) for row in rows)
    days = 7
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=9)))
    if now.month == 12:
        next_month = dt.datetime(now.year + 1, 1, 1, tzinfo=now.tzinfo)
    else:
        next_month = dt.datetime(now.year, now.month + 1, 1, tzinfo=now.tzinfo)
    days_in_month = (next_month - dt.datetime(now.year, now.month, 1, tzinfo=now.tzinfo)).days
    daily_average = spend / days
    return {
        "dateRange": rows[0].get("日付") or "",
        "days": days,
        "spend": round(spend),
        "sales": round(sales),
        "clicks": round(clicks),
        "orders": round(orders),
        "roas": round(sales / spend * 100, 1) if spend else None,
        "dailyAverage": round(daily_average),
        "projectedMonthlySpend": round(daily_average * days_in_month),
        "source": "rpp_item_reports_7d.csv",
    }


def performance_date_range() -> str | None:
    rows = _read_cp932_csv("rpp_item_reports.csv")
    if not rows:
        return None
    return str(rows[0].get("日付") or "").strip() or None


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


def validate_snapshot_readback(payload: dict, snapshot: dict, read_status: int) -> None:
    expected_at = dt.datetime.fromisoformat(payload["syncedAt"].replace("Z", "+00:00"))
    actual_value = snapshot.get("syncedAt")
    actual_at = dt.datetime.fromisoformat(actual_value.replace("Z", "+00:00")) if isinstance(actual_value, str) else None
    if read_status != 200 or actual_at is None or abs((actual_at - expected_at).total_seconds()) >= 0.001:
        raise RuntimeError(f"snapshot readback mismatch: HTTP {read_status}")
    if snapshot.get("schemaVersion") != 4:
        raise RuntimeError("snapshot readback mismatch: schemaVersion")
    expected_rpp_data = payload["rppData"]
    actual_rpp_data = snapshot.get("rppData") or {}
    for key in ("configuredTargets", "allConfiguredTargets", "exclusionProducts", "owners"):
        if len(actual_rpp_data.get(key) or []) != len(expected_rpp_data[key]):
            raise RuntimeError(f"snapshot rppData readback mismatch: {key}")
    expected_ids = {str(row.get("id") or "") for row in expected_rpp_data["allConfiguredTargets"]}
    actual_ids = {str(row.get("id") or "") for row in actual_rpp_data["allConfiguredTargets"]}
    if actual_ids != expected_ids:
        raise RuntimeError("snapshot rppData readback mismatch: allConfiguredTargets IDs")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    source, recommendations = latest_recommendation()
    summary_data = recommendations.setdefault("summary", {})
    summary_data["budgetMetrics"] = budget_metrics()
    summary_data["performanceDateRange"] = performance_date_range()
    rpp_data = operational_data()
    payload = {
        "syncedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "recommendations": recommendations,
        "latestFiles": file_rows(),
        "cronStatus": cron_status(),
        "rppData": rpp_data,
    }
    summary = {"source": source.name, "recommendations": len(recommendations["recommendations"]), "files": len(payload["latestFiles"]), "configuredTargets": len(rpp_data["configuredTargets"]), "allConfiguredTargets": len(rpp_data["allConfiguredTargets"]), "exclusionProducts": len(rpp_data["exclusionProducts"]), "owners": len(rpp_data["owners"]), "dryRun": args.dry_run}
    if args.dry_run:
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    auth = token()
    status, posted = request("POST", auth, payload)
    if status != 201 or not posted.get("ok"):
        raise RuntimeError(f"snapshot POST failed: HTTP {status} {posted.get('error', 'unknown error')}")
    read_status, readback = request("GET", auth)
    snapshot = readback.get("snapshot") or {}
    validate_snapshot_readback(payload, snapshot, read_status)
    print(json.dumps({**summary, "dryRun": False, "syncedAt": payload["syncedAt"], "readback": "OK"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
