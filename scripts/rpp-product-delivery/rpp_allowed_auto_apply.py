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
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any

CODE_ROOT = Path(__file__).resolve().parent
PROJECT = Path("/Users/nob/Projects/rpp-8am-notify")
SETTINGS_PATH = PROJECT / "rpp_targets" / "rpp_auto_adjustment_settings.json"
TARGETS_PATH = PROJECT / "rpp_targets" / "rpp_alert_targets.json"
UPLOAD_DIR = PROJECT / "rpp_uploads"
WAL_PATH = PROJECT / "rpp_apply_logs" / "rpp_allowed_auto_apply_wal.json"
AUDIT_PATH = PROJECT / "rpp_apply_logs" / "rpp_allowed_auto_apply_audit.jsonl"
LOCK_PATH = Path("/tmp/rise-rpp-exclusion-worker.lock")
UPLOAD_HELPER = CODE_ROOT / "rpp_apply_approved_cpc_upload.py"
DEPLOY_VERIFIER = CODE_ROOT / "deploy_worker_runtime.py"
POST_REFRESH_SCRIPT = CODE_ROOT / "rpp_frequent_dashboard_refresh.py"
SETTINGS_REFRESH_SCRIPT = CODE_ROOT / "scripts_refresh_rpp_settings_csvs.py"
SNAPSHOT_SENDER = CODE_ROOT / "rpp_push_dashboard_snapshot.py"
RECOMMENDATION_SCRIPT = CODE_ROOT / "rpp_auto_recommendations.js"
POSITION_MONITOR_SCRIPT = CODE_ROOT / "rpp_position_monitor.js"
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


def load_wal(path: Path | None = None) -> dict[str, Any]:
    path = WAL_PATH if path is None else path
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


def tree_sha256(root: Path) -> str:
    if not root.is_dir() or root.is_symlink():
        raise RuntimeError("runtime dependency tree is missing or unsafe")
    digest = hashlib.sha256()
    root_resolved = root.resolve(strict=True)
    def walk(directory: Path) -> None:
        for entry in sorted(directory.iterdir(), key=lambda item: item.name):
            relative = entry.relative_to(root).as_posix().encode("utf-8")
            if entry.is_symlink():
                target = entry.resolve(strict=True)
                if target != root_resolved and root_resolved not in target.parents:
                    raise RuntimeError("runtime dependency symlink escapes immutable root")
                digest.update(relative + b"\0L" + os.readlink(entry).encode("utf-8") + b"\0")
            elif entry.is_dir():
                walk(entry)
            elif entry.is_file():
                digest.update(relative + b"\0F" + bytes.fromhex(sha256(entry)) + b"\0")
    walk(root)
    return digest.hexdigest()


def require_mutation_runtime() -> dict[str, Any]:
    generation = CODE_ROOT.resolve()
    runtime_root = (PROJECT / "rpp_apply_logs" / "runtime_exec").resolve()
    if runtime_root not in generation.parents or not generation.name.startswith("auto-apply-generation-"):
        raise RuntimeError("auto-apply requires a private verified generation")
    manifest = json.loads((PROJECT / "rpp_apply_logs" / "rpp_product_delivery_scheduler_deploy.json").read_text(encoding="utf-8"))
    activation = json.loads((PROJECT / "rpp_apply_logs" / "rpp_product_delivery_dispatcher_activation.json").read_text(encoding="utf-8"))
    commit = str(manifest.get("commit") or "")
    if (activation.get("activated") is not True or activation.get("activationHold") is True
            or activation.get("circuitProbePassed") is not True or activation.get("commit") != commit
            or os.environ.get("RPP_RUNTIME_COMMIT") != commit):
        raise RuntimeError("auto-apply runtime is not activated")
    import deploy_worker_runtime as deploy_verifier
    if Path(deploy_verifier.__file__).resolve() != DEPLOY_VERIFIER.resolve():
        raise RuntimeError("auto-apply deploy verifier escaped the private generation")
    deploy_verifier.require_activation(manifest)
    expected = manifest.get("artifacts") or {}
    dependency = manifest.get("runtimeDependencies") or {}
    node_root = Path(str(dependency.get("nodeRoot") or "")).resolve()
    python_root = Path(str(dependency.get("pythonRoot") or "")).resolve()
    browser_root = Path(str(dependency.get("browserRoot") or "")).resolve()
    executable = Path(str(dependency.get("chromiumExecutable") or "")).resolve()
    expected_root = (PROJECT / "runtime_dependencies" / commit).resolve()
    if (node_root != expected_root / "node_modules" or python_root != expected_root / "python_modules"
            or browser_root.parent != expected_root / "chromium" or browser_root not in executable.parents):
        raise RuntimeError("auto-apply browser dependency path is outside the manifest boundary")
    python_hash = str(dependency.get("pythonTreeSha256") or "")
    node_hash = str(dependency.get("nodeTreeSha256") or "")
    browser_hash = str(dependency.get("browserTreeSha256") or "")
    if (os.environ.get("NODE_PATH") != str(node_root) or tree_sha256(node_root) != node_hash
            or os.environ.get("RPP_PYTHON_PLAYWRIGHT_ROOT") != str(python_root)
            or os.environ.get("RPP_PYTHON_PLAYWRIGHT_TREE_SHA256") != python_hash
            or os.environ.get("RPP_CHROMIUM_BUNDLE_ROOT") != str(browser_root)
            or os.environ.get("RPP_CHROMIUM_TREE_SHA256") != browser_hash
            or os.environ.get("RPP_CHROMIUM_EXECUTABLE") != str(executable)
            or tree_sha256(python_root) != python_hash or tree_sha256(browser_root) != browser_hash):
        raise RuntimeError("auto-apply browser dependency attestation failed")
    for key, artifact in {"autoApply": Path(__file__), "autoApplyUploader": UPLOAD_HELPER,
                          "deployVerifier": DEPLOY_VERIFIER,
                          "dashboardRefreshOrchestrator": POST_REFRESH_SCRIPT,
                          "settingsRefresh": SETTINGS_REFRESH_SCRIPT, "snapshotSender": SNAPSHOT_SENDER,
                          "recommendationGenerator": RECOMMENDATION_SCRIPT,
                          "positionMonitor": POSITION_MONITOR_SCRIPT}.items():
        resolved = artifact.resolve()
        if (resolved.parent != generation or artifact.is_symlink() or sha256(resolved) != expected.get(key)):
            raise RuntimeError("auto-apply artifact is outside the verified generation")
    return manifest


def snapshot_token() -> str:
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


def unresolved_wal_entries(path: Path | None = None) -> list[dict[str, Any]]:
    path = WAL_PATH if path is None else path
    return [entry for entry in load_wal(path)["entries"] if entry.get("state") in UNRESOLVED_WAL_STATES]


def prepare_wal(operation: dict[str, Any], path: Path | None = None) -> None:
    path = WAL_PATH if path is None else path
    wal = load_wal(path)
    if any(entry.get("operationId") == operation.get("operationId") for entry in wal["entries"]):
        raise RuntimeError("auto-apply WAL operation ID collision")
    wal["entries"].append({**operation, "state": "PREPARED", "preparedAt": utc_now(), "updatedAt": utc_now()})
    fsync_json(path, wal)


def transition_wal(operation_id: str, state: str, details: dict[str, Any] | None = None, path: Path | None = None) -> None:
    path = WAL_PATH if path is None else path
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
        "PREPARED": {"SUBMITTING", "FAILED", "UNCERTAIN"},
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


def arm_prepared_wal(operation_id: str, details: dict[str, Any], path: Path | None = None) -> None:
    path = WAL_PATH if path is None else path
    wal = load_wal(path)
    matches = [entry for entry in wal["entries"] if entry.get("operationId") == operation_id]
    if len(matches) != 1 or matches[0].get("state") != "PREPARED":
        raise RuntimeError("auto-apply WAL PREPARED operation was not found uniquely")
    matches[0].update(details)
    matches[0]["updatedAt"] = utc_now()
    fsync_json(path, wal)


def wal_state(operation_id: str, path: Path | None = None) -> str:
    path = WAL_PATH if path is None else path
    matches = [entry for entry in load_wal(path)["entries"] if entry.get("operationId") == operation_id]
    if len(matches) != 1:
        raise RuntimeError("auto-apply WAL operation was not found uniquely")
    return str(matches[0].get("state") or "")


def terminate_process_group(pgid: int, process: subprocess.Popen[Any] | None = None) -> None:
    def group_alive() -> bool:
        if process is not None:
            process.poll()
        try:
            os.killpg(pgid, 0)
            return True
        except ProcessLookupError:
            return False
    for sig, seconds in ((signal.SIGTERM, 5), (signal.SIGKILL, 10)):
        if not group_alive():
            break
        os.killpg(pgid, sig)
        deadline = time.monotonic() + seconds
        while group_alive() and time.monotonic() < deadline:
            time.sleep(0.05)
    if group_alive():
        raise RuntimeError("auto-apply uploader process group could not be fenced")
    if process is not None:
        process.wait(timeout=1)


def handle_uploader_timeout(operation_id: str, process: subprocess.Popen[Any]) -> None:
    terminate_process_group(process.pid, process)
    state = wal_state(operation_id)
    if state in {"PREPARED", "SUBMITTING", "SUBMITTED"}:
        transition_wal(operation_id, "UNCERTAIN", {"verification": "UNKNOWN", "timeout": True})


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
            if action == "HOLD":
                if row.get("proposedCpc") is not None:
                    raise RuntimeError(f"FIXED HOLD recommendation proposedCpc must be null: {key!r}")
            else:
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
    env = {
        "HOME": "/Users/nob",
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "LANG": "ja_JP.UTF-8",
        "PYTHONNOUSERSITE": "1",
        "NODE_PATH": os.environ["NODE_PATH"],
        "PYTHONPATH": os.pathsep.join((str(CODE_ROOT), os.environ["RPP_PYTHON_PLAYWRIGHT_ROOT"])),
        "RPP_PROJECT_DIR": str(PROJECT),
        "RPP_ENABLE_PRODUCTION_UPLOAD": "1",
        "RPP_AUTO_APPLY_WAL": str(WAL_PATH),
        "RPP_AUTO_APPLY_OPERATION_ID": operation_id,
        "RPP_RUNTIME_COMMIT": os.environ["RPP_RUNTIME_COMMIT"],
        "RPP_ACTIVATION_RECEIPT": str(PROJECT / "rpp_apply_logs" / "rpp_product_delivery_dispatcher_activation.json"),
        "RPP_PYTHON_PLAYWRIGHT_ROOT": os.environ["RPP_PYTHON_PLAYWRIGHT_ROOT"],
        "RPP_PYTHON_PLAYWRIGHT_TREE_SHA256": os.environ["RPP_PYTHON_PLAYWRIGHT_TREE_SHA256"],
        "RPP_CHROMIUM_BUNDLE_ROOT": os.environ["RPP_CHROMIUM_BUNDLE_ROOT"],
        "RPP_CHROMIUM_TREE_SHA256": os.environ["RPP_CHROMIUM_TREE_SHA256"],
        "RPP_CHROMIUM_EXECUTABLE": os.environ["RPP_CHROMIUM_EXECUTABLE"],
    }
    uploader_command = [
        sys.executable,
        "-s",
        str(UPLOAD_HELPER),
        f"--csv={bundle['upload']}", "--execute", "--final-submit", "--confirm=RMS_CPC_UPLOAD",
        f"--operation-id={operation_id}",
    ]
    gate = PROJECT / "rpp_apply_logs" / f"rpp_auto_apply_start_gate_{uuid.uuid4().hex}"
    gate_code = ("import os,sys,time,pathlib; g=pathlib.Path(sys.argv[1]); deadline=time.time()+120; "
                 "\nwhile not g.exists() and time.time()<deadline: time.sleep(.05)"
                 "\nif not g.exists(): raise SystemExit(124)"
                 "\nos.execve(sys.argv[2], sys.argv[2:], os.environ)")
    command = [sys.executable, "-s", "-c", gate_code, str(gate), *uploader_command]
    process = subprocess.Popen(command, cwd=PROJECT, env=env, text=True, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True)
    try:
        arm_prepared_wal(operation_id, {"uploaderPid": process.pid, "uploaderPgid": process.pid,
                                        "startGate": str(gate), "uploaderCommand": str(UPLOAD_HELPER)})
    except Exception:
        terminate_process_group(process.pid, process)
        raise
    fd = os.open(gate, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.fsync(fd)
    os.close(fd)
    _fsync_directory(gate.parent)
    try:
        stdout, stderr = process.communicate(timeout=600)
    except subprocess.TimeoutExpired:
        handle_uploader_timeout(operation_id, process)
        stdout, stderr = process.stdout.read() if process.stdout else "", process.stderr.read() if process.stderr else ""
        raise RuntimeError("auto-apply uploader timed out")
    finally:
        gate.unlink(missing_ok=True)
    state = wal_state(operation_id)
    if process.returncode != 0:
        if state == "PREPARED":
            transition_wal(operation_id, "FAILED", {"failureStage": "BEFORE_SUBMIT"})
        elif state in {"SUBMITTING", "SUBMITTED"}:
            transition_wal(operation_id, "UNCERTAIN", {"verification": "UNKNOWN"})
        raise RuntimeError((stderr or stdout or f"exit {process.returncode}")[-4000:])
    if state != "VERIFIED":
        if state in {"SUBMITTING", "SUBMITTED"}:
            transition_wal(operation_id, "UNCERTAIN", {"verification": "UNKNOWN"})
        raise RuntimeError(f"uploader exited without VERIFIED WAL state: {state}")
    return {"operationId": operation_id, "itemCode": item, "keyword": keyword, "changeType": change_type(row), "beforeCpc": int(row["currentCpc"]), "afterCpc": int(row["proposedCpc"]), "bundle": {k: str(v) for k, v in bundle.items()}}


def run_post_refresh() -> None:
    env = {"HOME": "/Users/nob", "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
           "LANG": "ja_JP.UTF-8", "PYTHONNOUSERSITE": "1",
           "PYTHONPATH": os.pathsep.join((str(CODE_ROOT), os.environ["RPP_PYTHON_PLAYWRIGHT_ROOT"])),
           "RPP_PROJECT_DIR": str(PROJECT), "NODE_PATH": os.environ["NODE_PATH"],
           "RPP_SETTINGS_REFRESH_SCRIPT": str(SETTINGS_REFRESH_SCRIPT),
           "RPP_SNAPSHOT_SENDER": str(SNAPSHOT_SENDER),
           "RPP_RECOMMENDATION_SCRIPT": str(RECOMMENDATION_SCRIPT),
           "RPP_POSITION_MONITOR_SCRIPT": str(POSITION_MONITOR_SCRIPT),
           "RPP_PYTHON_PLAYWRIGHT_ROOT": os.environ["RPP_PYTHON_PLAYWRIGHT_ROOT"],
           "RPP_PYTHON_PLAYWRIGHT_TREE_SHA256": os.environ["RPP_PYTHON_PLAYWRIGHT_TREE_SHA256"],
           "RPP_CHROMIUM_BUNDLE_ROOT": os.environ["RPP_CHROMIUM_BUNDLE_ROOT"],
           "RPP_CHROMIUM_TREE_SHA256": os.environ["RPP_CHROMIUM_TREE_SHA256"],
           "RPP_CHROMIUM_EXECUTABLE": os.environ["RPP_CHROMIUM_EXECUTABLE"]}
    result = subprocess.run([sys.executable, "-s", str(POST_REFRESH_SCRIPT), "hourly"], cwd=PROJECT, env=env, text=True, capture_output=True, timeout=1200)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "post-apply refresh failed")[-4000:])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--report", action="store_true")
    args = parser.parse_args()
    if args.execute:
        require_mutation_runtime()
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
