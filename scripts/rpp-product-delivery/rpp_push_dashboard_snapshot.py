#!/usr/bin/env python3
"""Push the latest local RPP dashboard snapshot to Render."""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
from rpp_performance_contract import item_set_sha256, parse_performance_csv, parse_receipt_times, receipt_message as performance_receipt_message, rows_sha256, validate_batch_sequence

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


def performance_receipt_key() -> bytes:
    value = os.environ.get("RPP_PERFORMANCE_RECEIPT_HMAC_KEY", "").strip()
    if not value:
        result = subprocess.run(["security", "find-generic-password", "-s", "hermes.rpp.performance-receipt-hmac", "-w"], text=True, capture_output=True, check=False)
        value = result.stdout.strip() if result.returncode == 0 else ""
    if len(value) < 32:
        raise RuntimeError("RPP performance receipt HMAC key is not configured")
    return value.encode()



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


def exclusion_observation() -> dict | None:
    output = PROJECT / "rpp_exclude_items.csv"
    if not output.is_file():
        return None
    for receipt in sorted((PROJECT / "rpp_logs").glob("rpp_settings_refresh_*.json"), reverse=True):
        try:
            payload = json.loads(receipt.read_text(encoding="utf-8"))
            exclude = payload.get("exclude") if isinstance(payload, dict) else None
            expected = exclude.get("expected_count") if isinstance(exclude, dict) else None
            actual = exclude.get("rows") if isinstance(exclude, dict) else None
            receipt_output = Path(str(exclude.get("output") or "")).resolve() if isinstance(exclude, dict) else None
            if receipt_output != output.resolve() or not isinstance(expected, int) or not isinstance(actual, int):
                continue
            observed_at = dt.datetime.fromtimestamp(output.stat().st_mtime, dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            return {"observedAt": observed_at, "expectedCount": expected, "actualCount": actual,
                    "complete": expected == actual and receipt.stat().st_mtime >= output.stat().st_mtime}
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    return None


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
    result = {"configuredTargets": configured, "allConfiguredTargets": all_configured, "exclusionProducts": products, "owners": owners}
    observation = exclusion_observation()
    if observation is not None:
        result["exclusionObservation"] = observation
    return result


def _number(value: object) -> float:
    try:
        return float(str(value or "0").replace(",", ""))
    except ValueError:
        return 0.0


def performance_daily(path: Path | None = None) -> dict | None:
    path = path or (PROJECT / "rpp_item_reports.csv")
    if not path.exists():
        return None
    report_date, rows = parse_performance_csv(path)
    receipt = performance_receipt(path, report_date, rows)
    return {
        "source": receipt["source"],
        "sourceMtime": receipt["sourceMtime"],
        "date": report_date,
        "attribution": {"sales12h": True, "sales720h": True},
        "rows": rows,
        "receipt": receipt,
    }


def performance_receipt(path: Path, report_date: str, rows: list[dict]) -> dict:
    if not path.is_symlink():
        raise RuntimeError("RPP performance report must be an atomic generation pointer")
    resolved_report = path.resolve(strict=True)
    generations = (PROJECT / "rpp_performance_generations").resolve()
    if resolved_report.name != "rpp_item_reports.csv" or resolved_report.parent.parent != generations or resolved_report.is_symlink():
        raise RuntimeError("RPP performance generation pointer is outside the attested store")
    receipt_path = resolved_report.parent / "receipt.json"
    if not receipt_path.is_file() or receipt_path.is_symlink():
        raise RuntimeError("RPP performance generation receipt is missing")
    digest = hashlib.sha256(resolved_report.read_bytes()).hexdigest()
    row_count = len(rows)
    source_mtime = dt.datetime.fromtimestamp(resolved_report.stat().st_mtime, dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    for receipt_path in [receipt_path]:
        try:
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            signature = str(receipt.get("signature") or "")
            expected_signature = hmac.new(performance_receipt_key(), performance_receipt_message(receipt), hashlib.sha256).hexdigest()
            signature_valid = len(signature) == 64 and hmac.compare_digest(signature, expected_signature)
            output = Path(str(receipt.get("output") or "")).resolve()
            complete = receipt.get("ok") is True and receipt.get("download_complete") is True
            counts_match = receipt.get("expected_count") == receipt.get("actual_count") == row_count
            dates_match = receipt.get("start_date") == receipt.get("end_date") == report_date
            hash_matches = receipt.get("output_sha256") == digest
            fresh = receipt_path.stat().st_mtime >= path.stat().st_mtime
            provider_manifest_valid = isinstance(receipt.get("source_archive_bytes"), int) and receipt["source_archive_bytes"] > 0 and isinstance(receipt.get("source_csv_compressed_bytes"), int) and receipt["source_csv_compressed_bytes"] > 0 and isinstance(receipt.get("source_csv_uncompressed_bytes"), int) and receipt["source_csv_uncompressed_bytes"] > 0 and bool(re.fullmatch(r"[a-f0-9]{8}", str(receipt.get("source_csv_crc32") or ""))) and len(str(receipt.get("source_csv_name_sha256") or "")) == 64
            evidence_valid = receipt.get("version") == 1 and len(str(receipt.get("history_row_sha256") or "")) == 64 and len(str(receipt.get("source_archive_sha256") or "")) == 64 and len(str(receipt.get("verification_history_row_sha256") or "")) == 64 and len(str(receipt.get("verification_archive_sha256") or "")) == 64 and receipt.get("history_row_sha256") != receipt.get("verification_history_row_sha256") and receipt.get("expected_item_set_sha256") == item_set_sha256(rows) and receipt.get("source") == path.name and receipt.get("source_mtime") == source_mtime and receipt.get("rows_sha256") == rows_sha256(rows) and provider_manifest_valid
            verification_receipt = {"request_started_at": receipt.get("verification_request_started_at"), "history_created_at": receipt.get("verification_history_created_at"), "source_mtime": receipt.get("verification_source_mtime"), "completed_at": receipt.get("verification_completed_at")}
            validate_batch_sequence(verification_receipt, receipt, report_date=report_date)
            if output == path.resolve() and complete and counts_match and dates_match and hash_matches and fresh and signature_valid and evidence_valid:
                completed_at = str(receipt.get("completed_at") or "")
                return {"version": 1, "file": receipt_path.name, "completedAt": completed_at, "sha256": digest, "expectedCount": row_count, "actualCount": row_count, "expectedItemSetSha256": receipt["expected_item_set_sha256"], "requestStartedAt": receipt["request_started_at"], "historyCreatedAt": receipt["history_created_at"], "historyRowSha256": receipt["history_row_sha256"], "sourceArchiveSha256": receipt["source_archive_sha256"], "sourceArchiveBytes": receipt["source_archive_bytes"], "sourceCsvCrc32": receipt["source_csv_crc32"], "sourceCsvCompressedBytes": receipt["source_csv_compressed_bytes"], "sourceCsvUncompressedBytes": receipt["source_csv_uncompressed_bytes"], "sourceCsvNameSha256": receipt["source_csv_name_sha256"], "verificationRequestStartedAt": receipt["verification_request_started_at"], "verificationHistoryCreatedAt": receipt["verification_history_created_at"], "verificationHistoryRowSha256": receipt["verification_history_row_sha256"], "verificationArchiveSha256": receipt["verification_archive_sha256"], "verificationSourceMtime": receipt["verification_source_mtime"], "verificationCompletedAt": receipt["verification_completed_at"], "source": path.name, "sourceMtime": source_mtime, "rowsSha256": receipt["rows_sha256"], "signature": signature, "complete": True}
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    raise RuntimeError("verified product report download receipt was not found")


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


def _aware_datetime(value: object, field: str) -> dt.datetime:
    try:
        parsed = dt.datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except ValueError as exc:
        raise RuntimeError(f"RMS budget {field} is invalid") from exc
    if parsed.tzinfo is None:
        raise RuntimeError(f"RMS budget {field} must include timezone")
    return parsed


def _canonical_rms_budget(value: dict | None) -> dict | None:
    if value is None:
        return None
    canonical = dict(value)
    for field in ("attemptedAt", "observedAt"):
        if canonical.get(field) is not None:
            # JavaScript Date#toISOString (used by the Web normalizer) keeps
            # milliseconds, while Python may emit six-digit microseconds.
            canonical[field] = _aware_datetime(canonical[field], field).astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return canonical


def rms_budget_observation() -> dict | None:
    path = PROJECT / "rpp_budget_observation.json"
    if not path.is_file() or path.is_symlink():
        return None
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("version") != 1 or value.get("status") not in {"COMPLETE", "UNKNOWN"} or value.get("source") != "RMS_RPP_TOP_AND_CAMPAIGNS" or value.get("currency") != "JPY":
        raise RuntimeError("RMS budget observation is invalid")
    attempted = _aware_datetime(value.get("attemptedAt"), "attemptedAt")
    now = dt.datetime.now(dt.timezone.utc)
    if attempted > now:
        raise RuntimeError("RMS budget attemptedAt must not be in the future")
    if value["status"] == "COMPLETE":
        observed = _aware_datetime(value.get("observedAt"), "observedAt")
        numeric = [value.get(key) for key in ("campaignCount", "activeCampaignCount", "effectiveBudget", "continuingBudget", "activeCampaignBudgetTotal", "allCampaignBudgetTotal")]
        try:
            dt.date.fromisoformat(str(value.get("asOfDate") or ""))
        except ValueError as exc:
            raise RuntimeError("RMS COMPLETE asOfDate is invalid") from exc
        if observed < attempted or observed - attempted > dt.timedelta(minutes=15) or observed > now or value.get("complete") is not True or any(not isinstance(v, int) or isinstance(v, bool) or v < 0 for v in numeric):
            raise RuntimeError("RMS COMPLETE budget observation is invalid")
        if value["activeCampaignCount"] > value["campaignCount"] or value["effectiveBudget"] != value["activeCampaignBudgetTotal"] or value["continuingBudget"] != value["allCampaignBudgetTotal"]:
            raise RuntimeError("RMS budget observation totals do not match")
    elif value.get("complete") is not False or any(value.get(key) is not None for key in ("observedAt", "asOfDate", "campaignCount", "activeCampaignCount", "effectiveBudget", "continuingBudget", "activeCampaignBudgetTotal", "allCampaignBudgetTotal")):
        raise RuntimeError("RMS UNKNOWN budget observation must not contain amounts")
    return value


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


def request(method: str, auth: str, payload: dict | None = None, query: str = "") -> tuple[int, dict]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        f"{API_BASE}/api/rpp/sync-snapshot{query}",
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


def post_snapshot(auth: str, payload: dict) -> tuple[dict, int, dict, bool]:
    status, posted = request("POST", auth, payload)
    stale_performance = (
        status == 400
        and payload.get("performanceDaily") is not None
        and posted.get("error") == "performance daily date is older than latest persisted date"
    )
    if not stale_performance:
        return payload, status, posted, False
    posted_payload = {**payload, "performanceDaily": None}
    status, posted = request("POST", auth, posted_payload)
    return posted_payload, status, posted, True


def validate_snapshot_readback(payload: dict, snapshot: dict, read_status: int, posted_snapshot: dict | None = None) -> None:
    if posted_snapshot is not None and snapshot != posted_snapshot:
        raise RuntimeError("snapshot full readback mismatch")
    expected_at = dt.datetime.fromisoformat(payload["syncedAt"].replace("Z", "+00:00"))
    actual_value = snapshot.get("syncedAt")
    actual_at = dt.datetime.fromisoformat(actual_value.replace("Z", "+00:00")) if isinstance(actual_value, str) else None
    if read_status != 200 or actual_at is None or abs((actual_at - expected_at).total_seconds()) >= 0.001:
        raise RuntimeError(f"snapshot readback mismatch: HTTP {read_status}")
    expected_schema = 5 if payload.get("rmsBudget") is not None else 4
    if snapshot.get("schemaVersion") != expected_schema:
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
    if actual_rpp_data.get("exclusionObservation") != expected_rpp_data.get("exclusionObservation"):
        raise RuntimeError("snapshot rppData readback mismatch: exclusionObservation")
    if _canonical_rms_budget(snapshot.get("rmsBudget")) != _canonical_rms_budget(payload.get("rmsBudget")):
        raise RuntimeError("snapshot RMS budget readback mismatch")
    expected_performance = payload.get("performanceDaily")
    actual_performance = snapshot.get("performanceDaily")
    if expected_performance is None:
        if actual_performance is not None:
            raise RuntimeError("snapshot performanceDaily readback mismatch")
    elif not isinstance(actual_performance, dict) or actual_performance.get("date") != expected_performance["date"] or len(actual_performance.get("rows") or []) != len(expected_performance["rows"]) or actual_performance.get("receipt") != expected_performance.get("receipt"):
        raise RuntimeError("snapshot performanceDaily readback mismatch")


def validate_performance_readback(expected: dict, response: dict, read_status: int) -> None:
    if read_status != 200 or response.get("date") != expected["date"] or not isinstance(response.get("rows"), list):
        raise RuntimeError(f"performance DB readback mismatch: HTTP {read_status}")
    actual_by_code = {str(row.get("itemCode") or ""): row for row in response["rows"]}
    expected_by_code = {row["itemCode"]: row for row in expected["rows"]}
    if set(actual_by_code) != set(expected_by_code):
        raise RuntimeError("performance DB readback mismatch: item codes")
    fields = ("clicks", "spend", "ctr", "sales12h", "orders12h", "sales720h", "orders720h")
    for item_code, wanted in expected_by_code.items():
        actual = actual_by_code[item_code]
        for field in fields:
            if wanted[field] is None and actual.get(field) is None:
                continue
            if float(actual.get(field)) != float(wanted[field]):
                raise RuntimeError(f"performance DB readback mismatch: {item_code} {field}")
        if actual.get("source") != expected["source"]:
            raise RuntimeError(f"performance DB readback mismatch: {item_code} source")
        actual_mtime = dt.datetime.fromisoformat(str(actual.get("sourceMtime") or "").replace("Z", "+00:00"))
        expected_mtime = dt.datetime.fromisoformat(expected["sourceMtime"].replace("Z", "+00:00"))
        if actual_mtime != expected_mtime:
            raise RuntimeError(f"performance DB readback mismatch: {item_code} sourceMtime")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--failure-reason", choices=("settings_failed", "recommendations_failed", "positions_failed"))
    args = parser.parse_args()
    if args.failure_reason:
        source = None
        recommendations = {"summary": {"degraded": True, "failureReason": args.failure_reason}, "recommendations": []}
    else:
        source, recommendations = latest_recommendation()
    summary_data = recommendations.setdefault("summary", {})
    summary_data["budgetMetrics"] = budget_metrics()
    summary_data["performanceDateRange"] = performance_date_range()
    rpp_data = operational_data()
    rms_budget = rms_budget_observation()
    payload = {
        "syncedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "recommendations": recommendations,
        "latestFiles": file_rows(),
        "cronStatus": cron_status(),
        "performanceDaily": performance_daily(),
        "rppData": rpp_data,
        "rmsBudget": rms_budget,
    }
    summary = {"source": source.name if source else "FAILURE_SNAPSHOT", "failureReason": args.failure_reason, "recommendations": len(recommendations["recommendations"]), "files": len(payload["latestFiles"]), "performanceDate": payload["performanceDaily"]["date"] if payload["performanceDaily"] else None, "performanceRows": len(payload["performanceDaily"]["rows"]) if payload["performanceDaily"] else 0, "configuredTargets": len(rpp_data["configuredTargets"]), "allConfiguredTargets": len(rpp_data["allConfiguredTargets"]), "exclusionProducts": len(rpp_data["exclusionProducts"]), "owners": len(rpp_data["owners"]), "rmsBudgetStatus": rms_budget.get("status") if rms_budget else "MISSING", "rmsEffectiveBudget": rms_budget.get("effectiveBudget") if rms_budget else None, "dryRun": args.dry_run}
    if args.dry_run:
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    auth = token()
    posted_payload, status, posted, stale_performance_skipped = post_snapshot(auth, payload)
    if status != 201 or not posted.get("ok"):
        raise RuntimeError(f"snapshot POST failed: HTTP {status} {posted.get('error', 'unknown error')}")
    read_status, readback = request("GET", auth)
    snapshot = readback.get("snapshot") or {}
    posted_snapshot = posted.get("snapshot")
    if not isinstance(posted_snapshot, dict):
        raise RuntimeError("snapshot POST did not return canonical snapshot")
    validate_snapshot_readback(posted_payload, snapshot, read_status, posted_snapshot)
    if posted_payload["performanceDaily"] is not None:
        performance_query = "?resource=performance-daily&date=" + urllib.parse.quote(posted_payload["performanceDaily"]["date"])
        performance_status, performance_readback = request("GET", auth, query=performance_query)
        validate_performance_readback(posted_payload["performanceDaily"], performance_readback, performance_status)
    print(json.dumps({**summary, "dryRun": False, "syncedAt": posted_payload["syncedAt"], "performanceDailySkippedAsStale": stale_performance_skipped, "readback": "OK"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
