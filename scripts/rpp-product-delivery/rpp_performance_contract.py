#!/usr/bin/env python3
"""Canonical RPP performance rows and receipt verification contract."""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import json
import re
from pathlib import Path

JST = dt.timezone(dt.timedelta(hours=9))


def number(value: object) -> float:
    try:
        return float(str(value or "0").replace(",", ""))
    except ValueError:
        return 0.0


def parse_performance_csv(path: Path) -> tuple[str, list[dict]]:
    with path.open("r", encoding="cp932", errors="strict", newline="") as handle:
        records = list(csv.DictReader(handle))
    if not records:
        raise RuntimeError("item daily report is empty")
    ranges = {str(row.get("日付") or "").strip() for row in records}
    if len(ranges) != 1:
        raise RuntimeError(f"item daily report contains multiple date ranges: {sorted(ranges)}")
    label = next(iter(ranges))
    match = re.fullmatch(r"(\d{4})年(\d{2})月(\d{2})日～(\d{4})年(\d{2})月(\d{2})日", label)
    if not match or match.group(1, 2, 3) != match.group(4, 5, 6):
        raise RuntimeError(f"item report is not a single-day report: {label}")
    report_date = dt.date.fromisoformat(f"{match.group(1)}-{match.group(2)}-{match.group(3)}")
    if report_date > dt.datetime.now(JST).date():
        raise RuntimeError(f"item daily report date is in the future: {report_date.isoformat()}")
    rows: list[dict] = []
    item_codes: set[str] = set()
    for row in records:
        item_code = str(row.get("商品管理番号") or "").strip().lower()
        if not item_code:
            continue
        if item_code in item_codes:
            raise RuntimeError(f"item daily report contains duplicate item: {item_code}")
        item_codes.add(item_code)
        rows.append({
            "itemCode": item_code,
            "ctr": number(row.get("CTR(%)")),
            "clicks": round(number(row.get("クリック数(合計)"))),
            "spend": round(number(row.get("実績額(合計)"))),
            "sales12h": round(number(row.get("売上金額(合計12時間)"))),
            "orders12h": round(number(row.get("売上件数(合計12時間)"))),
            "sales720h": round(number(row.get("売上金額(合計720時間)"))),
            "orders720h": round(number(row.get("売上件数(合計720時間)"))),
        })
    rows.sort(key=lambda row: row["itemCode"])
    return report_date.isoformat(), rows


def rows_sha256(rows: list[dict]) -> str:
    fields = ("itemCode", "ctr", "clicks", "spend", "sales12h", "orders12h", "sales720h", "orders720h")
    lines = []
    for row in sorted(rows, key=lambda value: str(value["itemCode"])):
        values = [str(row["itemCode"])] + [f"{float(row[field]):.6f}" for field in fields[1:]]
        lines.append("\t".join(values))
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()


RECEIPT_FIELDS = (
    "version", "output_sha256", "start_date", "end_date", "actual_count",
    "request_started_at", "history_created_at", "history_row_sha256",
    "source_archive_sha256", "source_archive_bytes", "source_csv_crc32",
    "source_csv_compressed_bytes", "source_csv_uncompressed_bytes",
    "source_csv_name_sha256", "source", "source_mtime", "completed_at",
    "rows_sha256",
)


def receipt_message(receipt: dict) -> bytes:
    return "\n".join(str(receipt.get(field, "")) for field in RECEIPT_FIELDS).encode()


def parse_receipt_times(receipt: dict, now: dt.datetime | None = None) -> tuple[dt.datetime, dt.datetime, dt.datetime, dt.datetime]:
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
    return request, history, source_mtime, completed
