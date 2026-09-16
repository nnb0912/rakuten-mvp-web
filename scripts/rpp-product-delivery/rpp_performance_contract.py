#!/usr/bin/env python3
"""Canonical RPP performance rows and receipt verification contract."""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import json
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path

JST = dt.timezone(dt.timedelta(hours=9))
ITEM_CODE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
INTEGER_MAX = 2_147_483_647
MONEY_MAX = 999_999_999_999


def number(value: object, field: str, *, integer: bool = False, maximum: int | Decimal | None = None, scale: int = 0) -> float | int:
    text = str(value if value is not None else "").strip()
    if not text:
        raise RuntimeError(f"item daily report {field} is blank")
    if not re.fullmatch(r"(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?", text):
        raise RuntimeError(f"item daily report {field} is not a plain decimal")
    try:
        parsed = Decimal(text.replace(",", ""))
    except InvalidOperation as exc:
        raise RuntimeError(f"item daily report {field} is not numeric") from exc
    if not parsed.is_finite() or parsed < 0:
        raise RuntimeError(f"item daily report {field} must be finite and non-negative")
    if integer and parsed != parsed.to_integral_value():
        raise RuntimeError(f"item daily report {field} must be an integer")
    if scale >= 0 and int(parsed.as_tuple().exponent) < -scale:
        raise RuntimeError(f"item daily report {field} has too many decimal places")
    if maximum is not None and parsed > Decimal(maximum):
        raise RuntimeError(f"item daily report {field} exceeds the database range")
    return int(parsed) if integer else float(parsed)


def parse_performance_csv(path: Path, *, expected_start: dt.date | None = None, expected_end: dt.date | None = None) -> tuple[str, list[dict]]:
    if (expected_start is None) != (expected_end is None):
        raise RuntimeError("expected_start and expected_end must be supplied together")
    with path.open("r", encoding="cp932", errors="strict", newline="") as handle:
        records = list(csv.DictReader(handle))
    if not records:
        raise RuntimeError("item daily report is empty")
    ranges = {str(row.get("日付") or "").strip() for row in records}
    if len(ranges) != 1:
        raise RuntimeError(f"item daily report contains multiple date ranges: {sorted(ranges)}")
    label = next(iter(ranges))
    match = re.fullmatch(r"(\d{4})年(\d{2})月(\d{2})日～(\d{4})年(\d{2})月(\d{2})日", label)
    if not match:
        raise RuntimeError(f"item report date range is invalid: {label}")
    report_start = dt.date.fromisoformat(f"{match.group(1)}-{match.group(2)}-{match.group(3)}")
    report_end = dt.date.fromisoformat(f"{match.group(4)}-{match.group(5)}-{match.group(6)}")
    if expected_start is None or expected_end is None:
        if report_start != report_end:
            raise RuntimeError(f"item report is not a single-day report: {label}")
    elif report_start != expected_start or report_end != expected_end or report_start > report_end:
        raise RuntimeError(f"item report date range does not match request: {label}")
    if report_end > dt.datetime.now(JST).date():
        raise RuntimeError(f"item report date is in the future: {report_end.isoformat()}")
    rows: list[dict] = []
    item_codes: set[str] = set()
    for row in records:
        item_code = str(row.get("商品管理番号") or "").strip().lower()
        if not item_code:
            continue
        if not ITEM_CODE_RE.fullmatch(item_code):
            raise RuntimeError("item daily report itemCode is invalid")
        if item_code in item_codes:
            raise RuntimeError(f"item daily report contains duplicate item: {item_code}")
        item_codes.add(item_code)
        rows.append({
            "itemCode": item_code,
            "ctr": number(row.get("CTR(%)"), "CTR", maximum=100, scale=4),
            "clicks": number(row.get("クリック数(合計)"), "clicks", integer=True, maximum=INTEGER_MAX),
            "spend": number(row.get("実績額(合計)"), "spend", integer=True, maximum=MONEY_MAX),
            "sales12h": number(row.get("売上金額(合計12時間)"), "sales12h", integer=True, maximum=MONEY_MAX),
            "orders12h": number(row.get("売上件数(合計12時間)"), "orders12h", integer=True, maximum=INTEGER_MAX),
            "sales720h": number(row.get("売上金額(合計720時間)"), "sales720h", integer=True, maximum=MONEY_MAX),
            "orders720h": number(row.get("売上件数(合計720時間)"), "orders720h", integer=True, maximum=INTEGER_MAX),
        })
    rows.sort(key=lambda row: row["itemCode"])
    return report_end.isoformat(), rows


def rows_sha256(rows: list[dict]) -> str:
    fields = ("itemCode", "ctr", "clicks", "spend", "sales12h", "orders12h", "sales720h", "orders720h")
    lines = []
    for row in sorted(rows, key=lambda value: str(value["itemCode"]).encode("utf-8")):
        values = [str(row["itemCode"])]
        for field in fields[1:]:
            if row[field] is None:
                values.append("null")
                continue
            scale = 10_000 if field == "ctr" else 1
            scaled = Decimal(str(row[field])) * scale
            if not scaled.is_finite() or scaled != scaled.to_integral_value():
                raise RuntimeError(f"performance canonical field {field} is invalid")
            values.append(f"i:{int(scaled)}")
        lines.append("\t".join(values))
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()


def item_set_sha256(rows: list[dict]) -> str:
    return hashlib.sha256("\n".join(sorted((str(row["itemCode"]) for row in rows), key=lambda value: value.encode("utf-8"))).encode()).hexdigest()


def validate_batch_quorum(expected_rows: list[dict], actual_rows: list[dict]) -> tuple[int, str]:
    expected_set = {str(row["itemCode"]) for row in expected_rows}
    actual_set = {str(row["itemCode"]) for row in actual_rows}
    if len(expected_rows) != len(expected_set) or len(actual_rows) != len(actual_set) or expected_set != actual_set:
        raise RuntimeError("RPP item report independent batch quorum mismatch")
    return len(expected_rows), hashlib.sha256("\n".join(sorted(expected_set)).encode()).hexdigest()


RECEIPT_FIELDS = (
    "version", "output_sha256", "start_date", "end_date", "expected_count", "actual_count", "expected_item_set_sha256",
    "request_started_at", "history_created_at", "history_row_sha256",
    "source_archive_sha256", "source_archive_bytes", "source_csv_crc32",
    "source_csv_compressed_bytes", "source_csv_uncompressed_bytes",
    "source_csv_name_sha256", "verification_request_started_at", "verification_history_created_at",
    "verification_history_row_sha256", "verification_archive_sha256", "verification_source_mtime", "verification_completed_at", "source", "source_mtime", "completed_at",
    "rows_sha256",
)


def receipt_message(receipt: dict) -> bytes:
    return "\n".join(str(receipt.get(field, "")) for field in RECEIPT_FIELDS).encode()


def parse_receipt_times(receipt: dict, now: dt.datetime | None = None, report_date: str | None = None) -> tuple[dt.datetime, dt.datetime, dt.datetime, dt.datetime]:
    now = now or dt.datetime.now(dt.timezone.utc)
    request = dt.datetime.fromisoformat(str(receipt.get("request_started_at") or "").replace("Z", "+00:00"))
    history = dt.datetime.strptime(str(receipt.get("history_created_at") or ""), "%Y-%m-%d %H:%M:%S").replace(tzinfo=JST)
    completed = dt.datetime.fromisoformat(str(receipt.get("completed_at") or "").replace("Z", "+00:00"))
    source_mtime = dt.datetime.fromisoformat(str(receipt.get("source_mtime") or "").replace("Z", "+00:00"))
    for value in (request, completed, source_mtime):
        if value.tzinfo is None:
            raise ValueError("receipt timestamp must include timezone")
    request, completed, source_mtime = (value.astimezone(dt.timezone.utc) for value in (request, completed, source_mtime))
    history = history.astimezone(dt.timezone.utc)
    if history < request - dt.timedelta(seconds=5) or history > completed:
        raise ValueError("receipt history timestamp order is invalid")
    if source_mtime < request - dt.timedelta(seconds=5) or source_mtime > completed + dt.timedelta(seconds=5):
        raise ValueError("receipt source mtime order is invalid")
    if completed < request or completed > now + dt.timedelta(minutes=5) or request > now + dt.timedelta(minutes=5):
        raise ValueError("receipt completion timestamp order is invalid")
    if completed - request > dt.timedelta(minutes=30):
        raise ValueError("receipt generation duration is invalid")
    if now - completed > dt.timedelta(hours=36):
        raise ValueError("receipt is stale")
    if report_date:
        report_day = dt.date.fromisoformat(report_date)
        lag_days = (completed.astimezone(JST).date() - report_day).days
        if lag_days < 0 or lag_days > 2:
            raise ValueError("receipt report date relationship is invalid")
    return request, history, source_mtime, completed


def validate_batch_sequence(verification_receipt: dict, actual_receipt: dict, now: dt.datetime | None = None, report_date: str | None = None) -> None:
    verification = parse_receipt_times(verification_receipt, now=now, report_date=report_date)
    actual = parse_receipt_times(actual_receipt, now=now, report_date=report_date)
    if verification[3] > actual[0]:
        raise ValueError("verification batch must complete before actual batch starts")
