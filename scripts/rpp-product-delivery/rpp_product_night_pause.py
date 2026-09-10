#!/usr/bin/env python3
"""Pause selected RPP products overnight through verified one-row RMS writes.

Dry-run is the default. Production execution requires both the environment gate and
an exact CLI confirmation. The durable ledger contains only exclusions created by
this automation, so the morning phase never releases pre-existing exclusions.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import fcntl
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Set

PROJECT = Path(os.environ.get("RPP_PROJECT_DIR", "/Users/nob/Projects/rpp-8am-notify"))
WEB_PROJECT = Path(os.environ.get("RAKUTEN_MVP_WEB_DIR", "/Users/nob/Projects/rakuten-mvp-web"))
API_BASE = os.environ.get("RPP_DASHBOARD_URL", "https://rakuten-mvp-web.onrender.com").rstrip("/")
EXCLUDE_CSV = PROJECT / "rpp_exclude_items.csv"
LOG_DIR = PROJECT / "rpp_apply_logs"
LEDGER_PATH = LOG_DIR / "rpp_product_night_pause_ledger.json"
AUDIT_PATH = LOG_DIR / "rpp_product_night_pause_audit.jsonl"
UPLOAD_DIR = LOG_DIR / "rpp_product_night_pause_uploads"
ADAPTER = WEB_PROJECT / "scripts" / "rpp_apply_exclusion_upload.mjs"
NODE_BIN = os.environ.get("RPP_EXCLUSION_NODE_BIN", "/opt/homebrew/bin/node")
ENV_FILE = PROJECT / ".env"
LOCK_PATH = Path(os.environ.get("RPP_EXCLUSION_WORKER_LOCK", "/tmp/rise-rpp-exclusion-worker.lock"))
PRODUCTION_CONFIRMATION = "RPP_PRODUCT_NIGHT_PAUSE"
ITEM_CODE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,99}$")
UTC = dt.timezone.utc


def utc_now() -> str:
    return dt.datetime.now(UTC).isoformat().replace("+00:00", "Z")


def normalize_code(value: object) -> str:
    if not isinstance(value, str):
        raise RuntimeError("invalid item code: values must be strings")
    code = value.strip().lower()
    if code and not ITEM_CODE_RE.fullmatch(code):
        raise RuntimeError("invalid item code: %r" % value)
    return code


def normalize_selection(payload: object) -> List[str]:
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise RuntimeError("night-pause response must contain ok=true")
    values = payload.get("itemCodes")
    if not isinstance(values, list):
        raise RuntimeError("night-pause response itemCodes must be an array")
    return sorted({code for code in (normalize_code(value) for value in values) if code})


def plan_off(selected: Iterable[str], current_exclusions: Set[str]) -> Dict[str, List[str]]:
    normalized = sorted(set(selected))
    return {
        "apply": [code for code in normalized if code not in current_exclusions],
        "preexisting": [code for code in normalized if code in current_exclusions],
    }


def plan_on(ledger_codes: Set[str], current_exclusions: Set[str]) -> Dict[str, List[str]]:
    return {
        "apply": sorted(code for code in ledger_codes if code in current_exclusions),
        "alreadyActive": sorted(code for code in ledger_codes if code not in current_exclusions),
        "preexisting": [],
    }


def _read_csv_text(path: Path) -> str:
    raw = path.read_bytes()
    errors = []
    for encoding in ("cp932", "utf-8-sig"):
        try:
            text = raw.decode(encoding)
            lines = text.splitlines()
            if lines and "商品管理番号" in lines[0]:
                return text
            errors.append("%s decoded without the expected header" % encoding)
        except UnicodeDecodeError as exc:
            errors.append(str(exc))
    raise RuntimeError("could not decode exclusion CSV: %s" % "; ".join(errors))


def read_current_exclusions(path: Path = EXCLUDE_CSV) -> Set[str]:
    if not path.exists():
        raise RuntimeError("current exclusion CSV was not found: %s" % path)
    rows = csv.DictReader(_read_csv_text(path).splitlines())
    if not rows.fieldnames or "商品管理番号" not in rows.fieldnames:
        raise RuntimeError("current exclusion CSV is missing 商品管理番号")
    codes = set()
    for row in rows:
        code = normalize_code(row.get("商品管理番号") or "")
        if code:
            codes.add(code)
    return codes


def write_one_row_csv(path: Path, control: str, item_code: str) -> None:
    if control not in {"n", "d"}:
        raise ValueError("control must be n or d")
    code = normalize_code(item_code)
    if not code:
        raise ValueError("item code is empty")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="cp932", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\r\n")
        writer.writerow(["コントロールカラム", "商品管理番号"])
        writer.writerow([control, code])


def require_production_gate(execute: bool, confirmation: Optional[str], environ: Mapping[str, str]) -> None:
    if not execute:
        return
    if environ.get("RPP_ENABLE_PRODUCT_NIGHT_PAUSE") != "1":
        raise RuntimeError("RPP_ENABLE_PRODUCT_NIGHT_PAUSE=1 is required for --execute")
    if confirmation != PRODUCTION_CONFIRMATION:
        raise RuntimeError("--confirm=%s is required for --execute" % PRODUCTION_CONFIRMATION)


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def snapshot_token() -> str:
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


def fetch_selection(api_base: str = API_BASE) -> List[str]:
    query = urllib.parse.urlencode({"resource": "night-pause"})
    request = urllib.request.Request(
        "%s/api/rpp/sync-snapshot?%s" % (api_base.rstrip("/"), query),
        headers={
            "Authorization": "Bearer %s" % snapshot_token(),
            "Accept": "application/json",
            "User-Agent": "rise-rpp-product-night-pause/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            if response.status != 200:
                raise RuntimeError("night-pause fetch failed: HTTP %s" % response.status)
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise RuntimeError("night-pause fetch failed: HTTP %s %s" % (exc.code, detail)) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError("night-pause fetch failed: %s" % exc.reason) from exc
    return normalize_selection(payload)


def read_ledger(path: Optional[Path] = None) -> Set[str]:
    path = path or LEDGER_PATH
    if not path.exists():
        return set()
    payload = json.loads(path.read_text(encoding="utf-8"))
    values = payload.get("itemCodes") if isinstance(payload, dict) else None
    if not isinstance(values, list):
        raise RuntimeError("night-pause ledger is invalid: %s" % path)
    return {code for code in (normalize_code(value) for value in values) if code}


def write_ledger(codes: Set[str], path: Optional[Path] = None) -> None:
    path = path or LEDGER_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": 1, "updatedAt": utc_now(), "itemCodes": sorted(codes)}
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def append_audit(entry: dict, path: Optional[Path] = None) -> None:
    path = path or AUDIT_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def acquire_global_lock(path: Path = LOCK_PATH) -> Optional[int]:
    fd = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return None
    os.ftruncate(fd, 0)
    os.write(fd, str(os.getpid()).encode("ascii"))
    return fd


def release_global_lock(fd: int) -> None:
    fcntl.flock(fd, fcntl.LOCK_UN)
    os.close(fd)


def run_adapter(csv_path: Path, control: str, item_code: str, wal_path: Optional[Path] = None, operation_id: Optional[str] = None) -> dict:
    if not ADAPTER.exists():
        raise RuntimeError("RMS exclusion adapter was not found: %s" % ADAPTER)
    env = os.environ.copy()
    env["RPP_ENABLE_RMS_EXCLUSION_UPLOAD"] = "1"
    command = [
        NODE_BIN,
        str(ADAPTER),
        "--csv",
        str(csv_path),
        "--execute",
        "--final-submit",
        "--confirm=RMS_EXCLUSION_UPLOAD",
        "--expected-before=%s" % ("active" if control == "n" else "excluded"),
    ]
    if bool(wal_path) != bool(operation_id):
        raise RuntimeError("wal_path and operation_id must be paired")
    if wal_path and operation_id:
        command.extend(["--wal-stage-file=%s" % wal_path, "--operation-id=%s" % operation_id])
    process = subprocess.run(
        command,
        cwd=str(WEB_PROJECT),
        env=env,
        text=True,
        capture_output=True,
        timeout=600,
    )
    if process.returncode != 0:
        detail = (process.stderr or process.stdout or "adapter exit %s" % process.returncode).strip()
        raise RuntimeError(detail[-3000:])
    try:
        result = json.loads(process.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("RMS adapter did not return JSON") from exc
    verify_adapter_result(result, control, item_code)
    return result


def verify_adapter_result(result: object, control: str, item_code: str) -> None:
    if not isinstance(result, dict) or result.get("ok") is not True or result.get("productionChange") is not True:
        raise RuntimeError("RMS adapter did not confirm a production change")
    rows = result.get("rows")
    if not isinstance(rows, list) or len(rows) != 1:
        raise RuntimeError("RMS adapter result was not exactly one row")
    row = rows[0]
    if row.get("control") != control or normalize_code(row.get("itemCode")) != item_code:
        raise RuntimeError("RMS adapter row did not match the requested change")
    readback = (result.get("applied") or {}).get("readback")
    before_readback = (result.get("applied") or {}).get("beforeReadback")
    before_matches = [entry for entry in before_readback or [] if normalize_code(entry.get("itemCode")) == item_code]
    expected_before_found = control == "d"
    if len(before_matches) != 1 or before_matches[0].get("found") is not expected_before_found:
        raise RuntimeError("RMS adapter exact precondition did not verify %s" % item_code)
    matches = [entry for entry in readback or [] if normalize_code(entry.get("itemCode")) == item_code]
    expected_found = control == "n"
    if len(matches) != 1 or matches[0].get("found") is not expected_found:
        raise RuntimeError("RMS adapter exact readback did not verify %s" % item_code)


def fixture_selection(path: Path) -> List[str]:
    return normalize_selection(json.loads(path.read_text(encoding="utf-8")))


def _upload_path(control: str, code: str, upload_dir: Path = UPLOAD_DIR) -> Path:
    stamp = dt.datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    return upload_dir / ("%s_%s_%s.csv" % (stamp, control, code))


def execute_plan(
    phase: str,
    codes: List[str],
    current: Set[str],
    ledger: Set[str],
    ledger_path: Path = LEDGER_PATH,
    audit_path: Path = AUDIT_PATH,
    upload_dir: Path = UPLOAD_DIR,
) -> dict:
    control = "n" if phase == "off" else "d"
    expected_after = control == "n"
    succeeded = []
    failures = []
    for code in codes:
        csv_path = _upload_path(control, code, upload_dir)
        write_one_row_csv(csv_path, control, code)
        before = code in current
        audit = {
            "timestamp": utc_now(),
            "phase": phase,
            "itemCode": code,
            "control": control,
            "before": {"excluded": before},
            "after": {"excluded": None},
            "verified": False,
            "productionChange": None,
            "csvPath": str(csv_path),
        }
        try:
            result = run_adapter(csv_path, control, code)
            audit["after"] = {"excluded": expected_after}
            audit["verified"] = True
            audit["productionChange"] = True
            audit["readback"] = (result.get("applied") or {}).get("readback")
            if phase == "off":
                ledger.add(code)
            else:
                ledger.discard(code)
            write_ledger(ledger, ledger_path)
            succeeded.append(code)
        except Exception as exc:
            audit["error"] = str(exc)[-3000:]
            failures.append({"itemCode": code, "error": str(exc)[-1000:]})
        finally:
            append_audit(audit, audit_path)
    return {"succeeded": succeeded, "failures": failures, "ledger": sorted(ledger)}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=("off", "on"), required=True)
    parser.add_argument("--execute", action="store_true", help="perform verified RMS writes")
    parser.add_argument("--confirm")
    parser.add_argument("--selection-fixture", type=Path, help="offline JSON fixture for OFF planning/tests")
    parser.add_argument("--exclude-csv", type=Path, default=EXCLUDE_CSV)
    parser.add_argument("--ledger", type=Path, default=LEDGER_PATH)
    parser.add_argument("--audit", type=Path, default=AUDIT_PATH)
    parser.add_argument("--api-base", default=API_BASE)
    parser.add_argument("--quiet", action="store_true")
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    load_env_file(ENV_FILE)
    require_production_gate(args.execute, args.confirm, os.environ)

    lock_fd = None
    if args.execute:
        lock_fd = acquire_global_lock()
        if lock_fd is None:
            raise RuntimeError("RMS exclusion worker lock is held")
    try:
        current = read_current_exclusions(args.exclude_csv)
        ledger = read_ledger(args.ledger)
        if args.phase == "off":
            selected = fixture_selection(args.selection_fixture) if args.selection_fixture else fetch_selection(args.api_base)
            plan = plan_off(selected, current)
        else:
            selected = []
            plan = plan_on(ledger, current)
        summary = {
            "ok": True,
            "phase": args.phase,
            "dryRun": not args.execute,
            "selected": selected,
            "currentExclusionCount": len(current),
            "ledgerBefore": sorted(ledger),
            "apply": plan["apply"],
            "preexisting": plan["preexisting"],
        }
        if not args.execute:
            if not args.quiet:
                print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
            return 0
        for code in plan.get("alreadyActive", []):
            ledger.discard(code)
        if plan.get("alreadyActive"):
            write_ledger(ledger, args.ledger)
        outcome = execute_plan(
            args.phase,
            plan["apply"],
            current,
            ledger,
            ledger_path=args.ledger,
            audit_path=args.audit,
        )
        summary.update(outcome)
        summary["ok"] = not outcome["failures"]
        summary["dryRun"] = False
        if not args.quiet:
            print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
        return 0 if summary["ok"] else 1
    finally:
        if lock_fd is not None:
            release_global_lock(lock_fd)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print("ERROR: %s" % error, file=sys.stderr)
        raise SystemExit(1)
