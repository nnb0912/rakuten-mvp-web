#!/usr/bin/env python3
"""Auto-apply verified RPP CPC recommendations and restore FIXED CPC drift."""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import fcntl
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import uuid
from pathlib import Path
from typing import Any

CODE_ROOT = Path(__file__).resolve().parent
PROJECT = Path(os.environ.get("RPP_PROJECT_DIR", str(CODE_ROOT))).resolve()
SETTINGS_PATH = PROJECT / "rpp_targets" / "rpp_auto_adjustment_settings.json"
TARGETS_PATH = PROJECT / "rpp_targets" / "rpp_alert_targets.json"
UPLOAD_DIR = PROJECT / "rpp_uploads"
WAL_PATH = PROJECT / "rpp_apply_logs" / "rpp_allowed_auto_apply_wal.json"
AUDIT_PATH = PROJECT / "rpp_apply_logs" / "rpp_allowed_auto_apply_audit.jsonl"
LOCK_PATH = Path(os.environ.get("RPP_EXCLUSION_WORKER_LOCK", "/tmp/rise-rpp-exclusion-worker.lock"))
AUTOMATIC_MODES = {"ROAS", "POSITION", "BALANCED"}
FIXED_MODE = "FIXED"
VALID_MODES = AUTOMATIC_MODES | {FIXED_MODE}
VALID_SOURCES = {"商品CPC", "キーワードCPC"}
CHANGEABLE_PROTECTION_TYPES = {"NORMAL", "WHITELIST", "FOCUS"}
DEFAULT_TARGETS_URL = "https://rakuten-mvp-web.onrender.com/api/rpp/sync-snapshot?resource=targets"
UNRESOLVED_WAL_STATES = {"PREPARED", "SUBMITTING", "SUBMITTED", "UNCERTAIN", "UNKNOWN"}
ALL_WAL_STATES = UNRESOLVED_WAL_STATES | {"VERIFIED", "FAILED"}
DEFAULT_MAX_CHANGES_PER_TICK = 3
HARD_MAX_CHANGES_PER_TICK = 3
JST = dt.timezone(dt.timedelta(hours=9))


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def open_exact_url(request: urllib.request.Request, expected_url: str, timeout: int):
    response = urllib.request.build_opener(NoRedirectHandler()).open(request, timeout=timeout)
    if response.geturl() != expected_url:
        response.close()
        raise RuntimeError("authenticated request final URL mismatch")
    return response


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _fsync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def fsync_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def append_audit(event: str, **details: Any) -> None:
    AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    record = {"at": utc_now(), "event": event, **details}
    fd = os.open(AUDIT_PATH, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, (json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)


def load_wal(path: Path = WAL_PATH) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "entries": []}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise RuntimeError("auto-apply WAL is unreadable; automatic writes blocked") from error
    if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("entries"), list):
        raise RuntimeError("auto-apply WAL is invalid; automatic writes blocked")
    for entry in value["entries"]:
        if not isinstance(entry, dict) or not entry.get("operationId") or entry.get("state") not in ALL_WAL_STATES:
            raise RuntimeError("auto-apply WAL entry is invalid; automatic writes blocked")
    return value


def snapshot_token() -> str:
    token = os.environ.get("RPP_SNAPSHOT_SYNC_TOKEN", "").strip()
    if token:
        return token
    result = subprocess.run(["security", "find-generic-password", "-s", "hermes.rpp.snapshot-sync", "-w"], text=True, capture_output=True)
    if result.returncode or not result.stdout.strip():
        raise RuntimeError("RPP target sync token is unavailable")
    return result.stdout.strip()


def sync_current_targets(path: Path = TARGETS_PATH) -> dict[str, Any]:
    configured = os.environ.get("RPP_TARGETS_URL", DEFAULT_TARGETS_URL).strip()
    if configured != DEFAULT_TARGETS_URL:
        raise RuntimeError("RPP target sync URL override is forbidden")
    url = DEFAULT_TARGETS_URL
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {snapshot_token()}", "Accept": "application/json", "User-Agent": "rise-rpp-fixed-sync/1.0"})
    try:
        with open_exact_url(request, url, timeout=30) as response:
            payload = json.load(response)
            status = response.status
    except Exception as error:
        raise RuntimeError("fresh RPP target sync failed") from error
    if status != 200 or not isinstance(payload, dict) or not isinstance(payload.get("targets"), list):
        raise RuntimeError("fresh RPP target sync response is invalid")
    synced = {"updatedAt": utc_now(), "source": url, "targets": payload["targets"]}
    fsync_json(path, synced)
    load_current_targets(path)
    return synced


def unresolved_wal_entries(path: Path = WAL_PATH) -> list[dict[str, Any]]:
    return [entry for entry in load_wal(path)["entries"] if entry.get("state") in UNRESOLVED_WAL_STATES]


def prepare_wal(operation: dict[str, Any], path: Path = WAL_PATH) -> None:
    wal = load_wal(path)
    if any(entry.get("operationId") == operation.get("operationId") for entry in wal["entries"]):
        raise RuntimeError("auto-apply WAL operation ID collision")
    wal["entries"].append({**operation, "state": "PREPARED", "preparedAt": utc_now(), "updatedAt": utc_now()})
    fsync_json(path, wal)


def transition_wal(operation_id: str, state: str, details: dict[str, Any] | None = None, path: Path = WAL_PATH) -> None:
    allowed = {"PREPARED", "SUBMITTING", "SUBMITTED", "VERIFIED", "UNCERTAIN", "UNKNOWN", "FAILED"}
    if state not in allowed:
        raise RuntimeError("invalid auto-apply WAL state")
    wal = load_wal(path)
    matches = [entry for entry in wal["entries"] if entry.get("operationId") == operation_id]
    if len(matches) != 1:
        raise RuntimeError("auto-apply WAL operation was not found uniquely")
    entry = matches[0]
    current = str(entry.get("state") or "")
    legal = {
        "PREPARED": {"SUBMITTING", "FAILED"},
        "SUBMITTING": {"SUBMITTED", "UNCERTAIN"},
        "SUBMITTED": {"VERIFIED", "UNCERTAIN"},
        "VERIFIED": set(), "UNCERTAIN": set(), "UNKNOWN": set(), "FAILED": set(),
    }
    if state not in legal.get(current, set()):
        raise RuntimeError(f"illegal auto-apply WAL transition: {current}->{state}")
    entry["state"] = state
    entry["updatedAt"] = utc_now()
    if details:
        entry.update(details)
    fsync_json(path, wal)


def wal_state(operation_id: str, path: Path = WAL_PATH) -> str:
    matches = [entry for entry in load_wal(path)["entries"] if entry.get("operationId") == operation_id]
    if len(matches) != 1:
        raise RuntimeError("auto-apply WAL operation was not found uniquely")
    return str(matches[0].get("state") or "")


def latest_recommendation_path() -> Path:
    files = sorted((PROJECT / "rpp_recommendations").glob("rpp_auto_recommendations_????????.json"))
    if not files:
        raise RuntimeError("recommendation JSON not found")
    return files[-1]


def load_json_strict(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise RuntimeError(f"{label} is missing or invalid") from error


def recommendation_key(row: dict[str, Any]) -> tuple[str, str]:
    item = str(row.get("itemCode") or "").strip().lower()
    source = str(row.get("source") or "").strip()
    if source not in VALID_SOURCES:
        raise RuntimeError(f"invalid recommendation source: {source!r}")
    keyword = "" if source == "商品CPC" else str(row.get("keyword") or "").strip()
    if not item or (source == "キーワードCPC" and not keyword):
        raise RuntimeError("recommendation key is missing")
    return item, keyword


def target_key(row: dict[str, Any]) -> tuple[str, str]:
    item = str(row.get("itemCode") or "").strip().lower()
    keyword = str(row.get("keyword") or "").strip()
    if not item or not keyword:
        raise RuntimeError("target key is missing")
    return item, "" if keyword == "商品CPC" else keyword


def expected_source_for_target(row: dict[str, Any]) -> str:
    return "商品CPC" if str(row.get("keyword") or "").strip() == "商品CPC" else "キーワードCPC"


def strict_integer(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise RuntimeError(f"{label} must be a JSON integer")
    return value


def require_changeable_target(row: dict[str, Any], key: tuple[str, str]) -> None:
    if row.get("changeLocked") is not False:
        raise RuntimeError(f"current target is change-locked or lock state is missing: {key!r}")
    protection = row.get("protectionType")
    if protection not in CHANGEABLE_PROTECTION_TYPES:
        raise RuntimeError(f"current target protection blocks changes or is invalid: {key!r}")


def load_current_targets(path: Path = TARGETS_PATH) -> dict[tuple[str, str], dict[str, Any]]:
    payload = load_json_strict(path, "current target configuration")
    if not isinstance(payload, dict) or not isinstance(payload.get("targets"), list):
        raise RuntimeError("current target configuration shape is invalid")
    source = str(payload.get("source") or "")
    configured = os.environ.get("RPP_TARGETS_URL", DEFAULT_TARGETS_URL).strip()
    if configured != DEFAULT_TARGETS_URL:
        raise RuntimeError("RPP target sync URL override is forbidden")
    expected_source = DEFAULT_TARGETS_URL
    if source != expected_source:
        raise RuntimeError("current target configuration source must equal the configured HTTPS sync URL")
    result: dict[tuple[str, str], dict[str, Any]] = {}
    for row in payload["targets"]:
        if not isinstance(row, dict):
            raise RuntimeError("current target row is invalid")
        key = target_key(row)
        if key in result:
            raise RuntimeError(f"duplicate current target key: {key!r}")
        mode = row.get("optimizationMode")
        if mode not in VALID_MODES:
            raise RuntimeError(f"invalid current optimization mode: {mode!r}")
        if mode == FIXED_MODE:
            try:
                fixed = strict_integer(row.get("fixedCpc"), "configured fixedCpc")
            except RuntimeError as error:
                raise RuntimeError(f"invalid configured fixedCpc for {key!r}") from error
            minimum = 20 if key[1] == "" else 40
            if fixed < minimum:
                raise RuntimeError(f"configured fixedCpc below minimum for {key!r}")
            row = {**row, "fixedCpc": fixed}
        result[key] = {**row, "_source": expected_source_for_target(row)}
    return result


def validate_recommendations_against_targets(data: dict[str, Any], targets: dict[tuple[str, str], dict[str, Any]]) -> None:
    recommendations = data.get("recommendations")
    if not isinstance(recommendations, list):
        raise RuntimeError("recommendations list is missing")
    seen: set[tuple[str, str]] = set()
    for row in recommendations:
        if not isinstance(row, dict):
            raise RuntimeError("recommendation row is invalid")
        key = recommendation_key(row)
        reasons = row.get("reasons")
        blocks = row.get("blocks")
        if not isinstance(reasons, list) or not reasons or any(not isinstance(value, str) or not value.strip() for value in reasons):
            raise RuntimeError(f"recommendation reasons contract is invalid: {key!r}")
        if not isinstance(blocks, list) or any(not isinstance(value, str) for value in blocks):
            raise RuntimeError(f"recommendation blocks contract is invalid: {key!r}")
        action = row.get("action")
        if action in {"RAISE", "LOWER"}:
            current = strict_integer(row.get("currentCpc"), "recommendation currentCpc")
            proposed = strict_integer(row.get("proposedCpc"), "recommendation proposedCpc")
            if (action == "RAISE" and proposed <= current) or (action == "LOWER" and proposed >= current):
                raise RuntimeError(f"recommendation action direction is invalid: {key!r}")
        elif action != "HOLD":
            raise RuntimeError(f"recommendation action is invalid: {key!r}")
        if key in seen:
            raise RuntimeError(f"duplicate recommendation key: {key!r}")
        seen.add(key)
        target = targets.get(key)
        if target is None:
            raise RuntimeError(f"current target is missing for recommendation: {key!r}")
        require_changeable_target(target, key)
        if row.get("source") != target["_source"]:
            raise RuntimeError(f"recommendation source does not match current target: {key!r}")
        if row.get("optimizationMode") != target.get("optimizationMode"):
            raise RuntimeError(f"recommendation mode does not match current target: {key!r}")
        if target.get("optimizationMode") == FIXED_MODE:
            try:
                proposed = strict_integer(row.get("proposedCpc"), "FIXED proposedCpc")
            except RuntimeError as error:
                raise RuntimeError(f"FIXED recommendation proposedCpc is invalid: {key!r}") from error
            if proposed != target["fixedCpc"]:
                raise RuntimeError(f"FIXED recommendation does not equal configured fixedCpc: {key!r}")


def change_type(row: dict[str, Any]) -> str:
    return "FIXED_SYNC" if row.get("optimizationMode") == FIXED_MODE else "AUTOMATIC_ADJUSTMENT"


def max_changes_per_tick() -> int:
    raw = os.environ.get("RPP_AUTO_APPLY_MAX_CHANGES", str(DEFAULT_MAX_CHANGES_PER_TICK))
    try:
        value = int(raw)
    except ValueError as error:
        raise RuntimeError("RPP_AUTO_APPLY_MAX_CHANGES must be an integer") from error
    if not 1 <= value <= HARD_MAX_CHANGES_PER_TICK:
        raise RuntimeError(f"RPP_AUTO_APPLY_MAX_CHANGES must be between 1 and {HARD_MAX_CHANGES_PER_TICK}")
    return value


def validate_snapshot(data: dict[str, Any], now: dt.datetime | None = None) -> None:
    current = now or dt.datetime.now(dt.timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=dt.timezone.utc)
    generated_raw = str((data.get("summary") or {}).get("generatedAt") or "")
    try:
        generated = dt.datetime.fromisoformat(generated_raw.replace("Z", "+00:00"))
    except ValueError as error:
        raise RuntimeError("recommendation generatedAt is missing or invalid") from error
    if generated.tzinfo is None or generated.utcoffset() is None:
        raise RuntimeError("recommendation generatedAt must include an explicit timezone")
    age = (current.astimezone(dt.timezone.utc) - generated.astimezone(dt.timezone.utc)).total_seconds()
    if age < -300 or age > 7200:
        raise RuntimeError(f"recommendation snapshot is stale or future-dated: ageSeconds={round(age)}")
    freshness = (((data.get("summary") or {}).get("safety") or {}).get("dataFreshness") or {})
    if freshness.get("readyForProduction") is not True:
        raise RuntimeError("recommendation data freshness is not ready for production")
    if ((data.get("summary") or {}).get("targetSync") or {}).get("ok") is not True:
        raise RuntimeError("recommendation target sync is not verified")


def eligible_recommendations(data: dict[str, Any], settings: dict[str, Any], now: dt.datetime | None = None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if settings.get("autoApplyEnabled") is not True:
        return [], [{"reason": "autoApplyEnabled is false"}]
    if settings.get("enabled") is not True:
        return [], [{"reason": "recommendation generation is disabled"}]
    eligible: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for row in data.get("recommendations") or []:
        item, keyword = recommendation_key(row)
        reason = None
        mode = row.get("optimizationMode")
        if mode not in VALID_MODES:
            reason = "optimization mode is not supported"
        elif row.get("action") not in {"RAISE", "LOWER"}:
            reason = "action is not RAISE/LOWER"
        elif row.get("uploadReady") is not True:
            reason = "uploadReady is false"
        elif row.get("blocks"):
            reason = "blocked"
        else:
            try:
                current = strict_integer(row.get("currentCpc"), "recommendation currentCpc")
                proposed = strict_integer(row.get("proposedCpc"), "recommendation proposedCpc")
            except RuntimeError:
                reason = "invalid CPC"
            else:
                if current <= 0 or proposed <= 0 or current == proposed:
                    reason = "CPC is unchanged or invalid"
        if reason:
            skipped.append({"itemCode": item, "keyword": keyword, "reason": reason})
        else:
            eligible.append(row)
    eligible.sort(key=lambda row: (0 if change_type(row) == "FIXED_SYNC" else 1, recommendation_key(row)[0], 0 if row.get("source") == "商品CPC" else 1, recommendation_key(row)[1]))
    return eligible, skipped


def write_bundle(row: dict[str, Any], tick_id: str, operation_id: str, now: dt.datetime | None = None) -> dict[str, Path]:
    moment = (now or dt.datetime.now(JST)).astimezone(JST)
    stamp = moment.strftime("%Y%m%d_%H%M%S_%f")
    unique = f"{stamp}_{tick_id}_{operation_id.split(':')[-1]}"
    item, _keyword_key = recommendation_key(row)
    kind = "item" if row.get("source") == "商品CPC" else "keyword"
    current = int(row["currentCpc"])
    proposed = int(row["proposedCpc"])
    keyword = str(row.get("keyword") or "")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    upload = UPLOAD_DIR / f"approved_{kind}_cpc_update_{unique}.csv"
    rollback = UPLOAD_DIR / f"rollback_{kind}_cpc_update_{unique}.csv"
    audit = UPLOAD_DIR / f"approved_cpc_update_{unique}_audit.csv"
    if any(path.exists() for path in (upload, rollback, audit)):
        raise RuntimeError("CPC bundle path collision")
    if kind == "item":
        upload_rows = [["コントロールカラム", "商品管理番号", "商品CPC"], ["u", item, proposed]]
        rollback_rows = [["コントロールカラム", "商品管理番号", "商品CPC"], ["u", item, current]]
        audit_keyword = "商品CPC"
    else:
        upload_rows = [["コントロールカラム", "商品管理番号", "キーワード", "キーワードCPC"], ["u", item, keyword, proposed]]
        rollback_rows = [["コントロールカラム", "商品管理番号", "キーワード", "キーワードCPC"], ["u", item, keyword, current]]
        audit_keyword = keyword
    for path, rows in ((upload, upload_rows), (rollback, rollback_rows)):
        with path.open("x", encoding="cp932", newline="") as handle:
            csv.writer(handle, lineterminator="\r\n").writerows(rows)
            handle.flush()
            os.fsync(handle.fileno())
    with audit.open("x", encoding="utf-8-sig", newline="") as handle:
        csv.writer(handle, lineterminator="\r\n").writerows([
            ["商品管理番号", "商品名", "キーワード", "判定", "変更前CPC", "提案CPC", "変更種別", "設定モード"],
            [item, str(row.get("itemName") or ""), audit_keyword, str(row.get("action") or ""), current, proposed, change_type(row), str(row.get("optimizationMode") or "")],
        ])
        handle.flush()
        os.fsync(handle.fileno())
    _fsync_directory(UPLOAD_DIR)
    return {"upload": upload, "rollback": rollback, "audit": audit}


def apply_one(row: dict[str, Any], tick_id: str, index: int) -> dict[str, Any]:
    operation_id = f"{tick_id}:{index}:{uuid.uuid4().hex}"
    bundle = write_bundle(row, tick_id, operation_id)
    item, keyword = recommendation_key(row)
    prepare_wal({
        "operationId": operation_id,
        "tickId": tick_id,
        "itemCode": item,
        "keyword": keyword,
        "source": row["source"],
        "beforeCpc": int(row["currentCpc"]),
        "afterCpc": int(row["proposedCpc"]),
        "bundle": {key: str(value) for key, value in bundle.items()},
        "bundleSha256": {key: sha256(value) for key, value in bundle.items()},
    })
    env = os.environ.copy()
    env.update({
        "RPP_ENABLE_PRODUCTION_UPLOAD": "1",
        "RPP_AUTO_APPLY_WAL": str(WAL_PATH),
        "RPP_AUTO_APPLY_OPERATION_ID": operation_id,
    })
    command = [
        sys.executable,
        os.environ.get("RPP_UPLOAD_HELPER", str(CODE_ROOT / "rpp_apply_approved_cpc_upload.py")),
        f"--csv={bundle['upload']}", "--execute", "--final-submit", "--confirm=RMS_CPC_UPLOAD",
        f"--operation-id={operation_id}",
    ]
    result = subprocess.run(command, cwd=PROJECT, env=env, text=True, capture_output=True, timeout=600)
    state = wal_state(operation_id)
    if result.returncode != 0:
        if state == "PREPARED":
            transition_wal(operation_id, "FAILED", {"failureStage": "BEFORE_SUBMIT"})
        elif state in {"SUBMITTING", "SUBMITTED"}:
            transition_wal(operation_id, "UNCERTAIN", {"verification": "UNKNOWN"})
        raise RuntimeError((result.stderr or result.stdout or f"exit {result.returncode}")[-4000:])
    if state != "VERIFIED":
        if state in {"SUBMITTING", "SUBMITTED"}:
            transition_wal(operation_id, "UNCERTAIN", {"verification": "UNKNOWN"})
        raise RuntimeError(f"uploader exited without VERIFIED WAL state: {state}")
    return {"operationId": operation_id, "itemCode": item, "keyword": keyword, "changeType": change_type(row), "beforeCpc": int(row["currentCpc"]), "afterCpc": int(row["proposedCpc"]), "bundle": {k: str(v) for k, v in bundle.items()}}


def run_post_refresh() -> None:
    script = os.environ.get("RPP_POST_REFRESH_SCRIPT", "").strip()
    if not script:
        raise RuntimeError("attested post-refresh script is not configured")
    result = subprocess.run([sys.executable, script, "hourly"], cwd=PROJECT, env=os.environ.copy(), text=True, capture_output=True, timeout=1200)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "post-apply refresh failed")[-4000:])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--report", action="store_true")
    args = parser.parse_args()
    sync_current_targets()
    settings = load_json_strict(SETTINGS_PATH, "auto-apply settings")
    if not isinstance(settings, dict):
        raise RuntimeError("auto-apply settings shape is invalid")
    data = load_json_strict(latest_recommendation_path(), "recommendation snapshot")
    if not isinstance(data, dict):
        raise RuntimeError("recommendation snapshot shape is invalid")
    validate_snapshot(data)
    targets = load_current_targets()
    validate_recommendations_against_targets(data, targets)
    eligible, skipped = eligible_recommendations(data, settings)
    limit = max_changes_per_tick()
    deferred = eligible[limit:]
    eligible = eligible[:limit]
    skipped.extend({"itemCode": recommendation_key(row)[0], "keyword": recommendation_key(row)[1], "reason": "deferred by per-tick write limit"} for row in deferred)
    if not args.execute:
        print(json.dumps({"ok": True, "dryRun": True, "maxChangesPerTick": limit, "eligible": [{"itemCode": recommendation_key(r)[0], "keyword": recommendation_key(r)[1], "changeType": change_type(r), "beforeCpc": r.get("currentCpc"), "afterCpc": r.get("proposedCpc")} for r in eligible], "skipped": skipped}, ensure_ascii=False))
        return 0
    unresolved = unresolved_wal_entries()
    if unresolved:
        raise RuntimeError("unresolved auto-apply WAL blocks automatic resend")
    if settings.get("autoApplyEnabled") is not True:
        raise RuntimeError("autoApplyEnabled is false")
    if not eligible:
        if args.report:
            print(json.dumps({"ok": True, "productionChange": False, "applied": [], "reason": "no verified CPC changes"}, ensure_ascii=False))
        return 0
    tick_id = f"{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}-{os.getpid()}-{uuid.uuid4().hex}"
    applied: list[dict[str, Any]] = []
    try:
        for index, row in enumerate(eligible, start=1):
            # Sequential by construction. PREPARED/SUBMITTING/UNCERTAIN all consume
            # one of the hard three write slots for this tick.
            applied.append(apply_one(row, tick_id, index))
        run_post_refresh()
    except Exception as error:
        production_change = bool(applied) or any(entry.get("tickId") == tick_id and entry.get("state") in {"SUBMITTING", "SUBMITTED", "VERIFIED", "UNCERTAIN", "UNKNOWN"} for entry in load_wal()["entries"])
        print(json.dumps({"ok": False, "productionChange": production_change, "tickId": tick_id, "applied": applied, "error": str(error)}, ensure_ascii=False))
        return 2
    print(json.dumps({"ok": True, "productionChange": True, "tickId": tick_id, "applied": applied, "readback": "VERIFIED", "postRefresh": "OK"}, ensure_ascii=False))
    return 0


def locked_main() -> int:
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            append_audit("LOCK_BUSY", lockPath=str(LOCK_PATH), exitCode=75)
            print(json.dumps({"ok": False, "productionChange": False, "errorCode": "LOCK_BUSY"}), file=sys.stderr)
            return 75
        append_audit("LOCK_ACQUIRED", lockPath=str(LOCK_PATH))
        try:
            return main()
        except Exception as error:
            append_audit("TICK_FAILED", errorCode=type(error).__name__.upper())
            print(json.dumps({"ok": False, "productionChange": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
            return 1
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


if __name__ == "__main__":
    raise SystemExit(locked_main())
