#!/usr/bin/env python3
"""Atomically deploy and verify the stable RPP delivery worker."""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

REPO = Path(__file__).resolve().parents[2]
PROJECT = Path("/Users/nob/Projects/rpp-8am-notify")
ARTIFACTS = {
    "scheduler": (REPO / "scripts" / "rpp-product-delivery" / "rpp_product_delivery_scheduler.py", PROJECT / "rpp_product_delivery_scheduler.py"),
    "schedulerTests": (REPO / "scripts" / "rpp-product-delivery" / "test_rpp_product_delivery_scheduler.py", PROJECT / "test_rpp_product_delivery_scheduler.py"),
    "nightPause": (REPO / "scripts" / "rpp-product-delivery" / "rpp_product_night_pause.py", PROJECT / "rpp_product_night_pause.py"),
    "nightPauseTests": (REPO / "scripts" / "rpp-product-delivery" / "test_rpp_product_night_pause.py", PROJECT / "test_rpp_product_night_pause.py"),
    "exclusionAdapter": (REPO / "scripts" / "rpp_apply_exclusion_upload.mjs", PROJECT / "rpp_apply_exclusion_upload.mjs"),
    "settingsRefresh": (REPO / "scripts" / "rpp-product-delivery" / "scripts_refresh_rpp_settings_csvs.py", PROJECT / "scripts_refresh_rpp_settings_csvs.py"),
    "settingsRefreshTests": (REPO / "scripts" / "rpp-product-delivery" / "test_scripts_refresh_rpp_settings_csvs.py", PROJECT / "test_scripts_refresh_rpp_settings_csvs.py"),
    "dashboardRefreshOrchestrator": (REPO / "scripts" / "rpp-product-delivery" / "rpp_frequent_dashboard_refresh.py", Path("/Users/nob/.hermes/scripts/rpp_frequent_dashboard_refresh.py")),
    "dashboardRefreshTests": (REPO / "scripts" / "rpp-product-delivery" / "test_rpp_frequent_dashboard_refresh.py", PROJECT / "test_rpp_frequent_dashboard_refresh.py"),
    "recommendationGenerator": (REPO / "scripts" / "rpp-product-delivery" / "rpp_auto_recommendations.js", PROJECT / "rpp_auto_recommendations.js"),
    "recommendationCpcAdvisor": (REPO / "scripts" / "rpp-product-delivery" / "rpp_cpc_advisor.js", PROJECT / "rpp_cpc_advisor.js"),
    "recommendationAdStatus": (REPO / "scripts" / "rpp-product-delivery" / "rpp_ad_status_report.js", PROJECT / "rpp_ad_status_report.js"),
    "recommendationPositionData": (REPO / "scripts" / "rpp-product-delivery" / "rpp_position_data.js", PROJECT / "rpp_position_data.js"),
    "recommendationDisplayNames": (REPO / "scripts" / "rpp-product-delivery" / "rpp_display_names.js", PROJECT / "rpp_display_names.js"),
    "recommendationNotifyOut": (REPO / "scripts" / "rpp-product-delivery" / "rpp_notify_out.js", PROJECT / "rpp_notify_out.js"),
    "recommendationDataGuards": (REPO / "scripts" / "rpp-product-delivery" / "rpp_data_guards.js", PROJECT / "rpp_data_guards.js"),
    "recommendationChatwork": (REPO / "scripts" / "rpp-product-delivery" / "chatwork_notify.js", PROJECT / "chatwork_notify.js"),
    "positionMonitor": (REPO / "scripts" / "rpp-product-delivery" / "rpp_position_monitor.js", PROJECT / "rpp_position_monitor.js"),
    "hourlyDashboardWrapper": (REPO / "scripts" / "rpp-product-delivery" / "rpp_hourly_dashboard_refresh.sh", Path("/Users/nob/.hermes/scripts/rpp_hourly_dashboard_refresh.sh")),
    "positionDashboardWrapper": (REPO / "scripts" / "rpp-product-delivery" / "rpp_position_dashboard_refresh.sh", Path("/Users/nob/.hermes/scripts/rpp_position_dashboard_refresh.sh")),
    "snapshotSender": (REPO / "scripts" / "rpp-product-delivery" / "rpp_push_dashboard_snapshot.py", Path("/Users/nob/.hermes/scripts/rpp_push_dashboard_snapshot.py")),
    "snapshotSenderTests": (REPO / "scripts" / "rpp-product-delivery" / "test_rpp_push_dashboard_snapshot.py", Path("/Users/nob/.hermes/scripts/test_rpp_push_dashboard_snapshot.py")),
    "productReportDownloader": (REPO / "scripts" / "rpp-product-delivery" / "scripts_refresh_rpp_product_report.py", PROJECT / "scripts_refresh_rpp_product_report.py"),
    "productReportDownloaderTests": (REPO / "scripts" / "rpp-product-delivery" / "test_scripts_refresh_rpp_product_report.py", PROJECT / "test_scripts_refresh_rpp_product_report.py"),
    "rmsLoginHelper": (REPO / "scripts" / "rpp-product-delivery" / "scripts_refresh_rpp_keyword_report.py", PROJECT / "scripts_refresh_rpp_keyword_report.py"),
    "performanceContract": (REPO / "scripts" / "rpp-product-delivery" / "rpp_performance_contract.py", PROJECT / "rpp_performance_contract.py"),
    "performanceCanonicalVectors": (REPO / "scripts" / "rpp-product-delivery" / "rpp_performance_canonical_vectors.json", PROJECT / "rpp_performance_canonical_vectors.json"),
    "snapshotPerformanceContract": (REPO / "scripts" / "rpp-product-delivery" / "rpp_performance_contract.py", Path("/Users/nob/.hermes/scripts/rpp_performance_contract.py")),
    "snapshotPerformanceCanonicalVectors": (REPO / "scripts" / "rpp-product-delivery" / "rpp_performance_canonical_vectors.json", Path("/Users/nob/.hermes/scripts/rpp_performance_canonical_vectors.json")),
    "schedulerWrapper": (REPO / "scripts" / "rpp-product-delivery" / "rpp_product_delivery_scheduler_tick.sh", Path("/Users/nob/.hermes/scripts/rpp_product_delivery_scheduler_tick.sh")),
    "schedulerDispatcher": (REPO / "scripts" / "rpp-product-delivery" / "rpp_product_delivery_dispatcher.py", PROJECT / "rpp_product_delivery_dispatcher.py"),
    "schedulerDispatcherTests": (REPO / "scripts" / "rpp-product-delivery" / "test_rpp_product_delivery_dispatcher.py", PROJECT / "test_rpp_product_delivery_dispatcher.py"),
    "schedulerDispatcherHealth": (REPO / "scripts" / "rpp-product-delivery" / "rpp_product_delivery_dispatcher_health.py", PROJECT / "rpp_product_delivery_dispatcher_health.py"),
    "schedulerDispatcherHealthWrapper": (REPO / "scripts" / "rpp-product-delivery" / "rpp_product_delivery_dispatcher_health_tick.sh", Path("/Users/nob/.hermes/scripts/rpp_product_delivery_dispatcher_health_tick.sh")),
    "schedulerDispatcherHealthTests": (REPO / "scripts" / "rpp-product-delivery" / "test_rpp_product_delivery_dispatcher_health.py", PROJECT / "test_rpp_product_delivery_dispatcher_health.py"),
    "schedulerDispatcherPlist": (REPO / "scripts" / "rpp-product-delivery" / "com.rise.rpp-product-delivery-dispatcher.plist", Path("/Users/nob/Library/LaunchAgents/com.rise.rpp-product-delivery-dispatcher.plist")),
    "runtimeManifestTests": (REPO / "scripts" / "rpp-product-delivery" / "test_rpp_runtime_manifest.py", PROJECT / "test_rpp_runtime_manifest.py"),
    "deployVerifier": (REPO / "scripts" / "rpp-product-delivery" / "deploy_worker_runtime.py", PROJECT / "deploy_worker_runtime.py"),
    "autoApply": (REPO / "scripts" / "rpp-product-delivery" / "rpp_allowed_auto_apply.py", PROJECT / "rpp_allowed_auto_apply.py"),
    "autoApplyTests": (REPO / "scripts" / "rpp-product-delivery" / "test_rpp_allowed_auto_apply.py", PROJECT / "test_rpp_allowed_auto_apply.py"),
    "autoApplyUploader": (REPO / "scripts" / "rpp-product-delivery" / "rpp_apply_approved_cpc_upload.py", PROJECT / "rpp_apply_approved_cpc_upload.py"),
    "autoApplyUploaderTests": (REPO / "scripts" / "rpp-product-delivery" / "test_rpp_apply_approved_cpc_upload.py", PROJECT / "test_rpp_apply_approved_cpc_upload.py"),
    "autoApplyWrapper": (REPO / "scripts" / "rpp-product-delivery" / "rpp_allowed_auto_apply.sh", Path("/Users/nob/.hermes/scripts/rpp_allowed_auto_apply.sh")),
}
BACKUP_DIR = PROJECT / "rpp_apply_logs" / "worker_backups"
MANIFEST = PROJECT / "rpp_apply_logs" / "rpp_product_delivery_scheduler_deploy.json"
PREFLIGHT_RECEIPT = PROJECT / "rpp_apply_logs" / "rpp_product_delivery_dispatcher_preflight.json"
CANARY_RECEIPT = PROJECT / "rpp_apply_logs" / "rpp_product_delivery_dispatcher_canary.json"
ACTIVATION_RECEIPT = PROJECT / "rpp_apply_logs" / "rpp_product_delivery_dispatcher_activation.json"
AUTO_APPLY_WAL = PROJECT / "rpp_apply_logs" / "rpp_allowed_auto_apply_wal.json"
HERMES_CRON_JOBS = Path("/Users/nob/.hermes/cron/jobs.json")
HEALTH_CRON_ID = "dd4c7ef598d1"
DISPATCHER_LABEL = "com.rise.rpp-product-delivery-dispatcher"
DISPATCHER_ARGUMENTS = [
    "/usr/bin/python3",
    "-s",
    "/Users/nob/Projects/rpp-8am-notify/deploy_worker_runtime.py",
    "--run-scheduler-dispatcher",
]
DEFAULT_API_BASE = "https://rakuten-mvp-web.onrender.com"
API_BASE = DEFAULT_API_BASE
NODE_DEPENDENCY_SOURCES = [REPO / "node_modules"]
PYTHON_SITE_PACKAGES = Path("/Users/nob/Library/Python/3.9/lib/python/site-packages")
PYTHON_DEPENDENCY_SOURCES = [PYTHON_SITE_PACKAGES / name for name in ("playwright", "greenlet", "pyee", "psycopg2", "typing_extensions.py")]
RUNTIME_DEPENDENCIES = PROJECT / "runtime_dependencies"
SHARED_WORKER_LOCK = Path("/tmp/rise-rpp-exclusion-worker.lock")


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def authenticated_api_url(path: str) -> str:
    configured = os.environ.get("RPP_DASHBOARD_URL", DEFAULT_API_BASE).rstrip("/")
    if configured != DEFAULT_API_BASE:
        raise RuntimeError("RPP dashboard URL override is forbidden")
    return f"{DEFAULT_API_BASE}{path}"


def open_exact_url(request: urllib.request.Request, expected_url: str, timeout: int):
    response = urllib.request.build_opener(NoRedirectHandler()).open(request, timeout=timeout)
    if response.geturl() != expected_url:
        response.close()
        raise RuntimeError("authenticated request final URL mismatch")
    return response


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_sha256(root: Path) -> str:
    if not root.is_dir() or root.is_symlink():
        raise RuntimeError("runtime dependency tree is missing or unsafe")
    root_resolved = root.resolve(strict=True)
    digest = hashlib.sha256()
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


def remove_readonly_tree(root: Path) -> None:
    if not root.exists():
        return
    for entry in sorted(root.rglob("*"), key=lambda item: len(item.parts), reverse=True):
        if not entry.is_symlink():
            entry.chmod(0o700 if entry.is_dir() else 0o600)
    root.chmod(0o700)
    shutil.rmtree(root)


def runtime_dependency_contract(manifest: dict, verify_hashes: bool = True) -> dict:
    dependency = manifest.get("runtimeDependencies") or {}
    commit = str(manifest.get("commit") or "")
    node_root = Path(str(dependency.get("nodeRoot") or ""))
    expected_node_root = (RUNTIME_DEPENDENCIES / commit / "node_modules").resolve()
    browser_root = Path(str(dependency.get("browserRoot") or ""))
    executable = Path(str(dependency.get("chromiumExecutable") or ""))
    expected_browser_parent = (RUNTIME_DEPENDENCIES / commit / "chromium").resolve()
    python_root = Path(str(dependency.get("pythonRoot") or ""))
    expected_python_root = (RUNTIME_DEPENDENCIES / commit / "python_modules").resolve()
    if (node_root.resolve() != expected_node_root or browser_root.resolve().parent != expected_browser_parent
            or python_root.resolve() != expected_python_root):
        raise RuntimeError("runtime dependency path is outside its pinned boundary")
    if browser_root.resolve() not in executable.resolve().parents:
        raise RuntimeError("Chromium executable is outside its pinned bundle")
    for key in ("nodeTreeSha256", "browserTreeSha256", "pythonTreeSha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", str(dependency.get(key) or "")):
            raise RuntimeError("runtime dependency digest is invalid")
    if verify_hashes:
        if (tree_sha256(node_root) != dependency["nodeTreeSha256"]
                or tree_sha256(browser_root) != dependency["browserTreeSha256"]
                or tree_sha256(python_root) != dependency["pythonTreeSha256"]):
            raise RuntimeError("runtime dependency tree does not match deploy manifest")
    return dependency


def secure_regular_file(path: Path) -> None:
    if path.is_symlink():
        raise RuntimeError("stable runtime path must not be a symlink")
    details = path.lstat()
    if not stat.S_ISREG(details.st_mode) or details.st_uid != os.getuid() or details.st_mode & 0o022:
        raise RuntimeError("stable runtime artifact ownership or permissions are unsafe")
    parent = path.parent
    while parent != parent.parent:
        details = parent.lstat()
        if parent.is_symlink():
            raise RuntimeError("stable runtime parent directory is unsafe")
        if details.st_uid != os.getuid():
            break
        if details.st_mode & 0o022:
            raise RuntimeError("stable runtime parent directory is unsafe")
        parent = parent.parent


def stable_bytes(path: Path) -> bytes:
    secure_regular_file(path)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        data = b""
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            data += chunk
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise RuntimeError("stable runtime artifact changed during verification")
    return data


def verified_bytes(path: Path, expected: str) -> bytes:
    data = stable_bytes(path)
    if hashlib.sha256(data).hexdigest() != expected:
        raise RuntimeError("stable runtime SHA-256 does not match deploy manifest")
    return data


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=REPO, text=True).strip()


def snapshot_token() -> str:
    result = subprocess.run(["security", "find-generic-password", "-s", "hermes.rpp.snapshot-sync", "-w"], text=True, capture_output=True)
    if result.returncode or not result.stdout.strip():
        raise RuntimeError("RPP snapshot sync token is unavailable")
    return result.stdout.strip()


def verify_web_contract() -> dict:
    url = authenticated_api_url("/api/rpp/sync-snapshot?resource=contract")
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {snapshot_token()}", "Accept": "application/json", "User-Agent": "rise-rpp-runtime-deploy/1.0"},
    )
    with open_exact_url(request, url, timeout=45) as response:
        payload = json.load(response)
    if response.status != 200 or payload.get("ok") is not True or payload.get("snapshotSchemaMax") != 5 or payload.get("rmsBudget") is not True or payload.get("canonicalSnapshotReadback") is not True:
        raise RuntimeError("live Web snapshot v5 contract is unavailable")
    return {"ok": True, "snapshotSchemaMax": 5, "rmsBudget": True, "canonicalSnapshotReadback": True}


def atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        Path(temp_name).unlink(missing_ok=True)


def verify_runtime() -> dict:
    if not MANIFEST.is_file() or MANIFEST.is_symlink():
        raise RuntimeError("stable runtime deploy manifest is missing")
    manifest = json.loads(stable_bytes(MANIFEST).decode("utf-8"))
    actual = {}
    for name, (_, target) in ARTIFACTS.items():
        if not target.is_file():
            raise RuntimeError("stable runtime artifact is missing")
        expected = str((manifest.get("artifacts") or {}).get(name) or "")
        data = verified_bytes(target, expected)
        actual[name] = hashlib.sha256(data).hexdigest()
    runtime_dependency_contract(manifest, verify_hashes=True)
    return {"ok": True, "mode": "verify", "commit": manifest.get("commit"), "artifacts": actual,
            "runtimeDependenciesVerified": True}


def require_activation(manifest: dict, *, allow_activation_hold: bool = False) -> dict:
    try:
        receipt = json.loads(ACTIVATION_RECEIPT.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("dispatcher runtime is installed but not activated") from exc
    if receipt.get("commit") != manifest.get("commit"):
        raise RuntimeError("dispatcher activation receipt does not match the runtime manifest")
    service = f"gui/{os.getuid()}/{DISPATCHER_LABEL}"
    loaded = subprocess.run(["launchctl", "print", service], capture_output=True, text=True)
    if loaded.returncode != 0:
        raise RuntimeError("attested dispatcher service is not loaded")
    loaded_pid = validate_loaded_dispatcher(loaded.stdout)
    if receipt.get("activated") is not True:
        if receipt.get("probe") is not True or os.environ.get("RPP_EVENT_DISPATCHER") != "1" or loaded_pid != os.getpid():
            raise RuntimeError("dispatcher runtime is installed but not activated")
        return receipt
    hold = receipt.get("activationHold") is True
    if hold and not allow_activation_hold:
        raise RuntimeError("dispatcher activation is held for read-only circuit verification")
    if not hold and receipt.get("circuitProbePassed") is not True:
        raise RuntimeError("dispatcher circuit probe attestation is missing")
    if receipt.get("dispatcherPid") != loaded_pid:
        raise RuntimeError("dispatcher activation PID does not match loaded launchd service")
    return receipt


def require_fresh_preflight(manifest: dict) -> dict:
    try:
        receipt = json.loads(PREFLIGHT_RECEIPT.read_text(encoding="utf-8"))
        completed_at = dt.datetime.fromisoformat(str(receipt.get("completedAt") or "").replace("Z", "+00:00"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("fresh dispatcher preflight receipt is required") from exc
    age = (dt.datetime.now(dt.timezone.utc) - completed_at.astimezone(dt.timezone.utc)).total_seconds()
    if (receipt.get("commit") != manifest.get("commit") or receipt.get("candidateSafe") is not True
            or receipt.get("productionChange") is not False or age < 0 or age > 600):
        raise RuntimeError("dispatcher preflight receipt is stale or does not match the runtime manifest")
    return receipt


def parse_launchd_status(output: str) -> dict:
    fields = {}
    for key in ("program", "state", "pid"):
        match = re.search(rf"^\s*{key}\s*=\s*(.+?)\s*$", output, re.MULTILINE)
        if match:
            fields[key] = match.group(1)
    arguments = []
    in_arguments = False
    for line in output.splitlines():
        stripped = line.strip()
        if stripped == "arguments = {":
            in_arguments = True
            continue
        if in_arguments and stripped == "}":
            break
        if in_arguments and stripped:
            arguments.append(re.sub(r"^\d+\s*=\s*", "", stripped))
    fields["arguments"] = arguments
    return fields


def validate_loaded_dispatcher(output: str) -> int:
    status = parse_launchd_status(output)
    if status.get("program") != DISPATCHER_ARGUMENTS[0] or status.get("arguments") != DISPATCHER_ARGUMENTS:
        raise RuntimeError("dispatcher loaded definition does not exactly match the attested plist")
    if status.get("state") != "running":
        raise RuntimeError("dispatcher service is not running")
    environment_match = re.search(r"^\s*environment\s*=\s*\{(.*?)^\s*\}", output, re.MULTILINE | re.DOTALL)
    if environment_match is None:
        raise RuntimeError("dispatcher loaded environment is unavailable")
    loaded_environment: dict[str, str] = {}
    for raw_line in environment_match.group(1).splitlines():
        if not raw_line.strip():
            continue
        match = re.fullmatch(r"\s*([A-Za-z_][A-Za-z0-9_]*) => ([^\r\n]*)", raw_line)
        if match is None:
            raise RuntimeError("dispatcher loaded environment is malformed")
        key, value = match.groups()
        if key in loaded_environment:
            raise RuntimeError("dispatcher loaded environment has duplicate keys")
        loaded_environment[key] = value
    expected_environment = {
        "HOME": "/Users/nob",
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "RPP_PROJECT_DIR": "/Users/nob/Projects/rpp-8am-notify",
        "RPP_EVENT_DISPATCHER": "1",
        "PYTHONNOUSERSITE": "1",
        # launchd injects these into the loaded process environment on this host.
        "OSLogRateLimit": "64",
        "XPC_SERVICE_NAME": DISPATCHER_LABEL,
    }
    if loaded_environment != expected_environment:
        raise RuntimeError("dispatcher loaded environment does not match the attested plist")
    try:
        pid = int(status.get("pid") or 0)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("dispatcher PID is invalid") from exc
    if pid <= 0:
        raise RuntimeError("dispatcher PID is invalid")
    return pid


def run_verified_scheduler(circuit_probe: bool = False) -> int:
    manifest = json.loads(stable_bytes(MANIFEST).decode("utf-8"))
    dependency = runtime_dependency_contract(manifest, verify_hashes=True)
    canary = os.environ.get("RPP_DEPLOYMENT_CANARY") == "1"
    activation_probe = False
    if circuit_probe:
        activation = require_activation(manifest, allow_activation_hold=True)
        if activation.get("activated") is not True or activation.get("activationHold") is not True:
            raise RuntimeError("circuit probe requires activation hold")
    elif canary:
        require_fresh_preflight(manifest)
    else:
        activation = require_activation(manifest)
        activation_probe = activation.get("probe") is True and activation.get("activated") is not True
    run_root = PROJECT / "rpp_apply_logs" / "runtime_exec"
    run_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix="generation-", dir=run_root) as directory:
        generation = Path(directory)
        for name, (_, target) in ARTIFACTS.items():
            expected = str((manifest.get("artifacts") or {}).get(name) or "")
            data = verified_bytes(target, expected)
            destination = generation / target.name
            if destination.exists():
                if destination.read_bytes() != data:
                    raise RuntimeError("runtime execution generation has a filename collision")
                continue
            destination.write_bytes(data)
            destination.chmod(0o500 if destination.suffix in {".py", ".sh"} else 0o400)
        scheduler = generation / ARTIFACTS["scheduler"][1].name
        env = {"HOME": "/Users/nob", "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
               "LANG": "ja_JP.UTF-8", "PYTHONNOUSERSITE": "1",
               "PYTHONPATH": os.pathsep.join((str(generation), str(dependency["pythonRoot"]))),
               "RPP_PROJECT_DIR": str(PROJECT), "RPP_ENABLE_PRODUCT_DELIVERY_SCHEDULER": "1"}
        env["RPP_SETTINGS_REFRESH_SCRIPT"] = str(generation / ARTIFACTS["settingsRefresh"][1].name)
        env["RPP_EXCLUSION_ADAPTER_PATH"] = str(generation / ARTIFACTS["exclusionAdapter"][1].name)
        env["RPP_PLAYWRIGHT_NODE_ROOT"] = str(dependency["nodeRoot"])
        env["RPP_PLAYWRIGHT_TREE_SHA256"] = str(dependency["nodeTreeSha256"])
        env["RPP_CHROMIUM_BUNDLE_ROOT"] = str(dependency["browserRoot"])
        env["RPP_CHROMIUM_TREE_SHA256"] = str(dependency["browserTreeSha256"])
        env["RPP_CHROMIUM_EXECUTABLE"] = str(dependency["chromiumExecutable"])
        env["RPP_PYTHON_PLAYWRIGHT_ROOT"] = str(dependency["pythonRoot"])
        env["RPP_PYTHON_PLAYWRIGHT_TREE_SHA256"] = str(dependency["pythonTreeSha256"])
        env["RPP_RUNTIME_COMMIT"] = str(manifest.get("commit") or "")
        env["RPP_ACTIVATION_RECEIPT"] = str(ACTIVATION_RECEIPT)
        command = ([sys.executable, "-s", str(scheduler), "--circuit-probe", "--confirm=RPP_CIRCUIT_PROBE"]
                   if circuit_probe else
                   ([sys.executable, "-s", str(scheduler), "--deployment-preflight",
                     "--confirm=RPP_PRODUCT_DELIVERY_DEPLOYMENT_PREFLIGHT"] if canary or activation_probe else
                    [sys.executable, "-s", str(scheduler), "--execute", "--confirm=RPP_PRODUCT_DELIVERY_SCHEDULER"]))
        process = subprocess.run(command, env=env, text=True, capture_output=True)
        if process.stdout:
            print(process.stdout, end="")
        if process.stderr:
            print(process.stderr, end="", file=sys.stderr)
        if activation_probe and process.returncode == 0:
            print(json.dumps({"ok": True, "kind": "rppDeliveryTick", "productionChange": False,
                              "deploymentProbe": True, "queueDepth": 0}, sort_keys=True))
        return process.returncode


def run_verified_dashboard_refresh(mode: str) -> int:
    manifest = json.loads(stable_bytes(MANIFEST).decode("utf-8"))
    dependency = runtime_dependency_contract(manifest, verify_hashes=True)
    run_root = PROJECT / "rpp_apply_logs" / "runtime_exec"
    run_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix="dashboard-generation-", dir=run_root) as directory:
        generation = Path(directory)
        for name, (_, target) in ARTIFACTS.items():
            expected = str((manifest.get("artifacts") or {}).get(name) or "")
            data = verified_bytes(target, expected)
            destination = generation / target.name
            if destination.exists():
                if destination.read_bytes() != data:
                    raise RuntimeError("runtime execution generation has a filename collision")
                continue
            destination.write_bytes(data)
            destination.chmod(0o500 if destination.suffix in {".py", ".sh", ".js"} else 0o400)
        env = {
            "HOME": "/Users/nob", "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG": "ja_JP.UTF-8", "PYTHONNOUSERSITE": "1",
            "PYTHONPATH": os.pathsep.join((str(generation), str(dependency["pythonRoot"]))),
            "RPP_PROJECT_DIR": str(PROJECT),
            "NODE_PATH": str(dependency["nodeRoot"]),
            "RPP_SETTINGS_REFRESH_SCRIPT": str(generation / ARTIFACTS["settingsRefresh"][1].name),
            "RPP_SNAPSHOT_SENDER": str(generation / ARTIFACTS["snapshotSender"][1].name),
            "RPP_RECOMMENDATION_SCRIPT": str(generation / ARTIFACTS["recommendationGenerator"][1].name),
            "RPP_POSITION_MONITOR_SCRIPT": str(generation / ARTIFACTS["positionMonitor"][1].name),
            "RPP_PYTHON_PLAYWRIGHT_ROOT": str(dependency["pythonRoot"]),
            "RPP_PYTHON_PLAYWRIGHT_TREE_SHA256": str(dependency["pythonTreeSha256"]),
            "RPP_CHROMIUM_BUNDLE_ROOT": str(dependency["browserRoot"]),
            "RPP_CHROMIUM_TREE_SHA256": str(dependency["browserTreeSha256"]),
            "RPP_CHROMIUM_EXECUTABLE": str(dependency["chromiumExecutable"]),
        }
        recommendation = generation / ARTIFACTS["recommendationGenerator"][1].name
        preflight = subprocess.run(["node", str(recommendation), "--runtime-preflight"], cwd=PROJECT, env=env, text=True, capture_output=True)
        if preflight.returncode != 0:
            raise RuntimeError("recommendation private-generation preflight failed")
        orchestrator = generation / ARTIFACTS["dashboardRefreshOrchestrator"][1].name
        process = subprocess.run([sys.executable, "-s", str(orchestrator), mode], env=env, text=True, capture_output=True)
        if process.stdout:
            print(process.stdout, end="")
        if process.stderr:
            print(process.stderr, end="", file=sys.stderr)
        return process.returncode


def run_verified_auto_apply() -> int:
    manifest = json.loads(stable_bytes(MANIFEST).decode("utf-8"))
    dependency = runtime_dependency_contract(manifest, verify_hashes=True)
    activation = require_activation(manifest)
    if activation.get("activated") is not True:
        raise RuntimeError("auto-apply requires final dispatcher activation")
    run_root = PROJECT / "rpp_apply_logs" / "runtime_exec"
    run_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix="auto-apply-generation-", dir=run_root) as directory:
        generation = Path(directory)
        for name, (_, target) in ARTIFACTS.items():
            expected = str((manifest.get("artifacts") or {}).get(name) or "")
            data = verified_bytes(target, expected)
            destination = generation / target.name
            if destination.exists():
                if destination.read_bytes() != data:
                    raise RuntimeError("runtime execution generation has a filename collision")
                continue
            destination.write_bytes(data)
            destination.chmod(0o500 if destination.suffix in {".py", ".sh", ".js"} else 0o400)
        env = {
            "HOME": "/Users/nob",
            "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG": "ja_JP.UTF-8", "PYTHONNOUSERSITE": "1",
            "PYTHONPATH": os.pathsep.join((str(generation), str(dependency["pythonRoot"]))),
            "RPP_PROJECT_DIR": str(PROJECT),
            "NODE_PATH": str(dependency["nodeRoot"]),
            "RPP_UPLOAD_HELPER": str(generation / ARTIFACTS["autoApplyUploader"][1].name),
            "RPP_POST_REFRESH_SCRIPT": str(generation / ARTIFACTS["dashboardRefreshOrchestrator"][1].name),
            "RPP_SETTINGS_REFRESH_SCRIPT": str(generation / ARTIFACTS["settingsRefresh"][1].name),
            "RPP_SNAPSHOT_SENDER": str(generation / ARTIFACTS["snapshotSender"][1].name),
            "RPP_RECOMMENDATION_SCRIPT": str(generation / ARTIFACTS["recommendationGenerator"][1].name),
            "RPP_POSITION_MONITOR_SCRIPT": str(generation / ARTIFACTS["positionMonitor"][1].name),
            "RPP_RUNTIME_COMMIT": str(manifest.get("commit") or ""),
            "RPP_ACTIVATION_RECEIPT": str(ACTIVATION_RECEIPT),
            "RPP_PYTHON_PLAYWRIGHT_ROOT": str(dependency["pythonRoot"]),
            "RPP_PYTHON_PLAYWRIGHT_TREE_SHA256": str(dependency["pythonTreeSha256"]),
            "RPP_CHROMIUM_BUNDLE_ROOT": str(dependency["browserRoot"]),
            "RPP_CHROMIUM_TREE_SHA256": str(dependency["browserTreeSha256"]),
            "RPP_CHROMIUM_EXECUTABLE": str(dependency["chromiumExecutable"]),
        }
        worker = generation / ARTIFACTS["autoApply"][1].name
        process = subprocess.run([sys.executable, "-s", str(worker), "--execute"], env=env, text=True, capture_output=True)
        if process.stdout:
            print(process.stdout, end="")
        if process.stderr:
            print(process.stderr, end="", file=sys.stderr)
        return process.returncode


def run_verified_dispatcher() -> int:
    manifest = json.loads(stable_bytes(MANIFEST).decode("utf-8"))
    dependency = runtime_dependency_contract(manifest, verify_hashes=True)
    require_activation(manifest)
    run_root = PROJECT / "rpp_apply_logs" / "runtime_exec"
    run_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix="delivery-dispatcher-generation-", dir=run_root) as directory:
        generation = Path(directory)
        for name, (_, target) in ARTIFACTS.items():
            expected = str((manifest.get("artifacts") or {}).get(name) or "")
            data = verified_bytes(target, expected)
            destination = generation / target.name
            if destination.exists():
                if destination.read_bytes() != data:
                    raise RuntimeError("runtime execution generation has a filename collision")
                continue
            destination.write_bytes(data)
            destination.chmod(0o500 if destination.suffix in {".py", ".sh", ".js"} else 0o400)
        dispatcher = generation / ARTIFACTS["schedulerDispatcher"][1].name
        env = {
            "HOME": "/Users/nob", "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG": "ja_JP.UTF-8", "PYTHONNOUSERSITE": "1",
            "PYTHONPATH": os.pathsep.join((str(generation), str(dependency["pythonRoot"]))),
            "RPP_EVENT_DISPATCHER": "1", "RPP_PROJECT_DIR": str(PROJECT),
            "RPP_RUNTIME_COMMIT": str(manifest.get("commit") or ""),
            "RPP_ACTIVATION_RECEIPT": str(ACTIVATION_RECEIPT),
            "RPP_PLAYWRIGHT_NODE_ROOT": str(dependency["nodeRoot"]),
            "RPP_PLAYWRIGHT_TREE_SHA256": str(dependency["nodeTreeSha256"]),
            "RPP_CHROMIUM_BUNDLE_ROOT": str(dependency["browserRoot"]),
            "RPP_CHROMIUM_TREE_SHA256": str(dependency["browserTreeSha256"]),
            "RPP_CHROMIUM_EXECUTABLE": str(dependency["chromiumExecutable"]),
            "RPP_PYTHON_PLAYWRIGHT_ROOT": str(dependency["pythonRoot"]),
            "RPP_PYTHON_PLAYWRIGHT_TREE_SHA256": str(dependency["pythonTreeSha256"]),
        }
        os.execve(sys.executable, [sys.executable, "-s", str(dispatcher)], env)
        raise RuntimeError("dispatcher exec unexpectedly returned")


def run_dispatcher_preflight() -> dict:
    manifest = json.loads(stable_bytes(MANIFEST).decode("utf-8"))
    dependency = runtime_dependency_contract(manifest, verify_hashes=True)
    run_root = PROJECT / "rpp_apply_logs" / "runtime_exec"
    run_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix="delivery-preflight-generation-", dir=run_root) as directory:
        generation = Path(directory)
        for name, (_, target) in ARTIFACTS.items():
            expected = str((manifest.get("artifacts") or {}).get(name) or "")
            data = verified_bytes(target, expected)
            destination = generation / target.name
            if destination.exists():
                if destination.read_bytes() != data:
                    raise RuntimeError("runtime preflight generation has a filename collision")
                continue
            destination.write_bytes(data)
            destination.chmod(0o500 if destination.suffix in {".py", ".sh", ".js"} else 0o400)
        scheduler = generation / ARTIFACTS["scheduler"][1].name
        env = {"HOME": "/Users/nob", "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
               "LANG": "ja_JP.UTF-8", "PYTHONNOUSERSITE": "1",
               "PYTHONPATH": os.pathsep.join((str(generation), str(dependency["pythonRoot"]))),
               "RPP_PROJECT_DIR": str(PROJECT), "RPP_ENABLE_PRODUCT_DELIVERY_SCHEDULER": "1"}
        env["RPP_SETTINGS_REFRESH_SCRIPT"] = str(generation / ARTIFACTS["settingsRefresh"][1].name)
        env["RPP_EXCLUSION_ADAPTER_PATH"] = str(generation / ARTIFACTS["exclusionAdapter"][1].name)
        env["RPP_PLAYWRIGHT_NODE_ROOT"] = str(dependency["nodeRoot"])
        env["RPP_PLAYWRIGHT_TREE_SHA256"] = str(dependency["nodeTreeSha256"])
        env["RPP_CHROMIUM_BUNDLE_ROOT"] = str(dependency["browserRoot"])
        env["RPP_CHROMIUM_TREE_SHA256"] = str(dependency["browserTreeSha256"])
        env["RPP_CHROMIUM_EXECUTABLE"] = str(dependency["chromiumExecutable"])
        env["RPP_PYTHON_PLAYWRIGHT_ROOT"] = str(dependency["pythonRoot"])
        env["RPP_PYTHON_PLAYWRIGHT_TREE_SHA256"] = str(dependency["pythonTreeSha256"])
        process = subprocess.run([
            sys.executable, str(scheduler), "--deployment-preflight",
            "--confirm=RPP_PRODUCT_DELIVERY_DEPLOYMENT_PREFLIGHT",
        ], env=env, text=True, capture_output=True, timeout=1800)
        if process.returncode != 0:
            raise RuntimeError("dispatcher candidate preflight failed")
        try:
            receipt = json.loads(process.stdout.strip().splitlines()[-1])
        except (IndexError, TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError("dispatcher candidate preflight receipt is invalid") from exc
        if (receipt.get("ok") is not True or receipt.get("candidateSafe") is not True
                or receipt.get("productionChange") is not False or receipt.get("queueDepth") != 0
                or receipt.get("plannedChanges") != 0):
            raise RuntimeError("dispatcher candidate preflight did not prove a safe no-change state")
        dispatcher = generation / ARTIFACTS["schedulerDispatcher"][1].name
        dispatcher_env = env.copy()
        dispatcher_env["RPP_RUNTIME_COMMIT"] = str(manifest.get("commit") or "")
        dispatcher_process = subprocess.run([sys.executable, str(dispatcher), "--preflight"],
                                            env=dispatcher_env, text=True, capture_output=True, timeout=120)
        if dispatcher_process.returncode != 0:
            raise RuntimeError("dispatcher snapshot/listener preflight failed")
        try:
            dispatcher_receipt = json.loads(dispatcher_process.stdout.strip().splitlines()[-1])
        except (IndexError, TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError("dispatcher snapshot/listener preflight receipt is invalid") from exc
        if (dispatcher_receipt.get("ok") is not True
                or dispatcher_receipt.get("kind") != "rppDeliveryDispatcherPreflight"
                or dispatcher_receipt.get("productionChange") is not False
                or dispatcher_receipt.get("listenerConnected") is not True
                or not isinstance(dispatcher_receipt.get("generation"), int)
                or not isinstance(dispatcher_receipt.get("serverNow"), str)):
            raise RuntimeError("dispatcher snapshot/listener preflight contract failed")
        persisted = {"schemaVersion": 1, "commit": manifest.get("commit"), "candidateSafe": True,
                     "productionChange": False, "generation": dispatcher_receipt["generation"],
                     "serverNow": dispatcher_receipt["serverNow"], "listenerConnected": True,
                     "completedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")}
        atomic_json(PREFLIGHT_RECEIPT, persisted)
        return {"ok": True, "mode": "dispatcher-preflight", **persisted}


def run_dispatcher_canary() -> dict:
    manifest = json.loads(stable_bytes(MANIFEST).decode("utf-8"))
    preflight = require_fresh_preflight(manifest)
    wrapper = ARTIFACTS["schedulerWrapper"][1]
    env = os.environ.copy()
    env["RPP_DEPLOYMENT_CANARY"] = "1"
    env["RPP_EVENT_DISPATCHER"] = "1"
    process = subprocess.run(["/bin/bash", str(wrapper)], env=env, text=True, capture_output=True, timeout=1800)
    if process.returncode != 0:
        raise RuntimeError("dispatcher no-change canary wrapper failed")
    receipt = None
    for line in reversed(process.stdout.splitlines()):
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and candidate.get("kind") == "rppDeliveryDeploymentPreflight":
            receipt = candidate
            break
    if (not isinstance(receipt, dict) or receipt.get("ok") is not True
            or receipt.get("candidateSafe") is not True or receipt.get("productionChange") is not False
            or int(receipt.get("queueDepth") or 0) != 0 or int(receipt.get("plannedChanges") or 0) != 0):
        raise RuntimeError("dispatcher canary did not prove an exact no-change scheduler wrapper tick")
    persisted = {"schemaVersion": 1, "commit": manifest.get("commit"), "noChange": True,
                 "preflightCompletedAt": preflight.get("completedAt"),
                 "completedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")}
    atomic_json(CANARY_RECEIPT, persisted)
    return {"ok": True, "mode": "dispatcher-canary", **persisted}


def restart_dispatcher_service() -> int:
    domain = f"gui/{os.getuid()}"
    service = f"{domain}/{DISPATCHER_LABEL}"
    plist = ARTIFACTS["schedulerDispatcherPlist"][1]
    expected_commit = str(json.loads(stable_bytes(MANIFEST).decode("utf-8")).get("commit") or "")
    started_at = dt.datetime.now(dt.timezone.utc)
    loaded = subprocess.run(["launchctl", "print", service], capture_output=True, text=True).returncode == 0
    if loaded:
        subprocess.run(["launchctl", "bootout", service], check=True, capture_output=True, text=True)
    subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True, capture_output=True, text=True)
    subprocess.run(["launchctl", "enable", service], check=True, capture_output=True, text=True)
    subprocess.run(["launchctl", "kickstart", "-k", service], check=True, capture_output=True, text=True)
    heartbeat = PROJECT / "rpp_apply_logs" / "rpp_product_delivery_dispatcher_heartbeat.json"
    deadline = time.monotonic() + 420
    last_error = "dispatcher heartbeat was not created"
    while time.monotonic() < deadline:
        status = subprocess.run(["launchctl", "print", service], capture_output=True, text=True)
        if status.returncode != 0:
            last_error = "dispatcher service is not loaded"
        else:
            try:
                service_pid = validate_loaded_dispatcher(status.stdout)
                if heartbeat.exists():
                    payload = json.loads(heartbeat.read_text(encoding="utf-8"))
                    observed = dt.datetime.fromisoformat(str(payload.get("at") or payload.get("armedAt") or "").replace("Z", "+00:00"))
                    if (observed >= started_at - dt.timedelta(seconds=2) and payload.get("ok") is True
                            and payload.get("manifestCommit") == expected_commit
                            and payload.get("pid") == service_pid
                            and payload.get("listenerConnected") is True
                            and payload.get("reason") == "waiting"
                            and payload.get("armedReason") not in {
                                "lock-retry", "backlog-retry", "overdue-retry", "startup-retry", "failure-retry"
                            }):
                        return service_pid
                    last_error = f"dispatcher heartbeat is unhealthy: {payload.get('reason') or payload.get('error')}"
            except (OSError, ValueError, TypeError, json.JSONDecodeError, RuntimeError) as exc:
                last_error = str(exc)[:500]
        time.sleep(2)
    raise RuntimeError(last_error)


def notify_dispatcher(expected_commit: str) -> None:
    code = (
        "import psycopg2; "
        "from rpp_product_delivery_dispatcher import listener_dsn, CHANNEL; "
        "c=psycopg2.connect(listener_dsn(),connect_timeout=15,application_name='rpp-dispatcher-activation'); "
        "c.set_session(autocommit=True); "
        "x=c.cursor(); x.execute('select pg_notify(%s,%s)',(CHANNEL,'-1')); c.close()"
    )
    manifest = json.loads(stable_bytes(MANIFEST).decode("utf-8"))
    if manifest.get("commit") != expected_commit:
        raise RuntimeError("dispatcher notification commit does not match manifest")
    dependency = runtime_dependency_contract(manifest, verify_hashes=True)
    run_root = PROJECT / "rpp_apply_logs" / "runtime_exec"
    run_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix="dispatcher-notify-generation-", dir=run_root) as directory:
        generation = Path(directory)
        target = ARTIFACTS["schedulerDispatcher"][1]
        data = verified_bytes(target, str((manifest.get("artifacts") or {}).get("schedulerDispatcher") or ""))
        dispatcher = generation / target.name
        dispatcher.write_bytes(data)
        dispatcher.chmod(0o500)
        env = {"HOME": "/Users/nob", "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
               "LANG": "ja_JP.UTF-8", "PYTHONNOUSERSITE": "1",
               "PYTHONPATH": os.pathsep.join((str(generation), str(dependency["pythonRoot"]))),
               "RPP_PROJECT_DIR": str(PROJECT), "RPP_RUNTIME_COMMIT": expected_commit}
        subprocess.run(["/usr/bin/python3", "-s", "-c", code], env=env, check=True,
                       capture_output=True, text=True, timeout=60)


def wait_probe_heartbeat(service_pid: int, expected_commit: str, probe_started_at: dt.datetime) -> None:
    heartbeat = PROJECT / "rpp_apply_logs" / "rpp_product_delivery_dispatcher_heartbeat.json"
    deadline = time.monotonic() + 420
    last_error = "post-activation heartbeat was not created"
    while time.monotonic() < deadline:
        status = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{DISPATCHER_LABEL}"], capture_output=True, text=True)
        try:
            if status.returncode != 0 or validate_loaded_dispatcher(status.stdout) != service_pid:
                raise RuntimeError("dispatcher PID changed during activation")
            payload = json.loads(heartbeat.read_text(encoding="utf-8"))
            observed = dt.datetime.fromisoformat(str(payload.get("at") or payload.get("armedAt") or "").replace("Z", "+00:00"))
            if (observed >= probe_started_at - dt.timedelta(seconds=1) and payload.get("ok") is True
                    and payload.get("pid") == service_pid and payload.get("manifestCommit") == expected_commit
                    and payload.get("listenerConnected") is True
                    and payload.get("armedReason") == "activation-probe"):
                return
            last_error = f"post-activation heartbeat is unhealthy: {payload.get('reason') or payload.get('error')}"
        except (OSError, ValueError, TypeError, json.JSONDecodeError, RuntimeError) as exc:
            last_error = str(exc)[:500]
        time.sleep(2)
    raise RuntimeError(last_error)


def deactivate_dispatcher_service() -> None:
    service = f"gui/{os.getuid()}/{DISPATCHER_LABEL}"
    if subprocess.run(["launchctl", "print", service], capture_output=True, text=True).returncode == 0:
        subprocess.run(["launchctl", "bootout", service], check=True, capture_output=True, text=True)


def fence_unresolved_auto_apply() -> None:
    if not AUTO_APPLY_WAL.exists():
        return
    try:
        wal = json.loads(stable_bytes(AUTO_APPLY_WAL).decode("utf-8"))
    except Exception as exc:
        raise RuntimeError("auto-apply WAL is unreadable; deployment blocked") from exc
    unresolved = [entry for entry in wal.get("entries", [])
                  if entry.get("state") in {"PREPARED", "SUBMITTING", "SUBMITTED", "UNCERTAIN", "UNKNOWN"}]
    for entry in unresolved:
        pid, pgid = entry.get("uploaderPid"), entry.get("uploaderPgid")
        operation_id = str(entry.get("operationId") or "")
        if isinstance(pid, int) and isinstance(pgid, int) and pid > 1 and pgid > 1:
            identity = subprocess.run(["/bin/ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True)
            command = identity.stdout.strip()
            if identity.returncode == 0 and operation_id and operation_id in command and "rpp_apply_approved_cpc_upload.py" in command:
                def group_alive() -> bool:
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
                    raise RuntimeError("auto-apply process group could not be fenced; deployment blocked")
            elif identity.returncode == 0:
                raise RuntimeError("auto-apply WAL process identity mismatch; deployment blocked without signalling")
    if unresolved:
        raise RuntimeError("unresolved auto-apply WAL fenced where provable; deployment blocked pending recovery")


def activate_dispatcher() -> dict:
    manifest = json.loads(stable_bytes(MANIFEST).decode("utf-8"))
    preflight = require_fresh_preflight(manifest)
    try:
        canary = json.loads(CANARY_RECEIPT.read_text(encoding="utf-8"))
        canary_at = dt.datetime.fromisoformat(str(canary.get("completedAt") or "").replace("Z", "+00:00"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("fresh no-change canary receipt is required") from exc
    canary_age = (dt.datetime.now(dt.timezone.utc) - canary_at.astimezone(dt.timezone.utc)).total_seconds()
    if (canary.get("commit") != manifest.get("commit") or canary.get("noChange") is not True
            or canary.get("preflightCompletedAt") != preflight.get("completedAt")
            or canary_age < 0 or canary_age > 600):
        raise RuntimeError("no-change canary receipt is stale or does not match the preflight/runtime")
    probe = {"schemaVersion": 1, "commit": manifest.get("commit"), "activated": False, "probe": True,
             "preflightCompletedAt": preflight.get("completedAt"),
             "canaryCompletedAt": canary.get("completedAt"),
             "probeStartedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")}
    atomic_json(ACTIVATION_RECEIPT, probe)
    try:
        service_pid = restart_dispatcher_service()
        probe_started_at = dt.datetime.now(dt.timezone.utc)
        notify_dispatcher(str(manifest.get("commit") or ""))
        wait_probe_heartbeat(service_pid, str(manifest.get("commit") or ""), probe_started_at)
        hold = {"schemaVersion": 1, "commit": manifest.get("commit"), "activated": True,
                "activationHold": True, "probe": False, "dispatcherPid": service_pid,
                "preflightCompletedAt": preflight.get("completedAt"),
                "canaryCompletedAt": canary.get("completedAt"),
                "holdStartedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")}
        atomic_json(ACTIVATION_RECEIPT, hold)
        if run_verified_scheduler(circuit_probe=True) != 0:
            raise RuntimeError("attested circuit probe failed during activation")
        activated_at = dt.datetime.now(dt.timezone.utc)
        activation = {"schemaVersion": 1, "commit": manifest.get("commit"), "activated": True,
                      "activationHold": False, "circuitProbePassed": True,
                      "probe": False, "dispatcherPid": service_pid,
                      "preflightCompletedAt": preflight.get("completedAt"),
                      "canaryCompletedAt": canary.get("completedAt"),
                      "activatedAt": activated_at.isoformat().replace("+00:00", "Z")}
        atomic_json(ACTIVATION_RECEIPT, activation)
    except Exception:
        ACTIVATION_RECEIPT.unlink(missing_ok=True)
        deactivate_dispatcher_service()
        raise
    return {"ok": True, "mode": "dispatcher-activate", **activation}


def verify_health_monitor(*, expected_enabled: bool) -> dict:
    try:
        payload = json.loads(stable_bytes(HERMES_CRON_JOBS).decode("utf-8"))
    except Exception as exc:
        raise RuntimeError("Hermes health-monitor cron registry is unreadable") from exc
    jobs = payload if isinstance(payload, list) else payload.get("jobs", [])
    matches = [job for job in jobs if job.get("id") == HEALTH_CRON_ID]
    if len(matches) != 1:
        raise RuntimeError("exactly one RPP dispatcher health-monitor cron is required")
    job = matches[0]
    schedule = job.get("schedule") or {}
    if (job.get("name") != "RPP商品配信dispatcher health監視"
            or schedule.get("kind") != "cron" or schedule.get("expr") != "*/10 * * * *"
            or job.get("script") != "rpp_product_delivery_dispatcher_health_tick.sh"
            or job.get("no_agent") is not True or job.get("deliver") != "origin"
            or job.get("enabled") is not expected_enabled
            or job.get("state") != ("scheduled" if expected_enabled else "paused")):
        raise RuntimeError("RPP dispatcher health-monitor cron definition/state does not match")
    return {"ok": True, "jobId": HEALTH_CRON_ID, "enabled": expected_enabled,
            "schedule": schedule.get("expr"), "script": job.get("script")}


def _deploy_under_lock() -> dict:
    verify_health_monitor(expected_enabled=False)
    fence_unresolved_auto_apply()
    if git("branch", "--show-current") != "main":
        raise RuntimeError("worker deploy requires main branch")
    if git("status", "--porcelain"):
        raise RuntimeError("worker deploy requires a clean working tree")
    head = git("rev-parse", "HEAD")
    if head != git("rev-parse", "origin/main"):
        raise RuntimeError("worker deploy requires HEAD to equal origin/main")
    verify_web_contract()
    source_hashes = {}
    for name, (source, _) in ARTIFACTS.items():
        if source.suffix == ".py":
            compile(source.read_text(encoding="utf-8"), str(source), "exec")
        elif source.suffix == ".sh":
            subprocess.run(["/bin/bash", "-n", str(source)], check=True, capture_output=True, text=True)
        elif source.suffix in {".js", ".mjs"}:
            subprocess.run(["node", "--check", str(source)], check=True, capture_output=True, text=True)
        source_hashes[name] = sha256(source)
    # Fail closed during cutover: no mutation-capable entrypoint may execute
    # the newly installed bytes until their own read-only preflight passes.
    deactivate_dispatcher_service()
    ACTIVATION_RECEIPT.unlink(missing_ok=True)
    PREFLIGHT_RECEIPT.unlink(missing_ok=True)
    CANARY_RECEIPT.unlink(missing_ok=True)
    PROJECT.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for name, (source, target) in ARTIFACTS.items():
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and sha256(target) != source_hashes[name]:
            backup = BACKUP_DIR / f"{target.stem}.pre-{stamp}-{sha256(target)[:12]}{target.suffix}"
            shutil.copy2(target, backup)
        fd, temp_name = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=target.parent)
        os.close(fd)
        try:
            shutil.copy2(source, temp_name)
            os.replace(temp_name, target)
        finally:
            Path(temp_name).unlink(missing_ok=True)
        backups = sorted(BACKUP_DIR.glob(f"{target.stem}.pre-*{target.suffix}"), key=lambda path: path.stat().st_mtime, reverse=True)
        for old in backups[3:]:
            old.unlink()
    dependency_target = RUNTIME_DEPENDENCIES / head / "node_modules"
    dependency_temp = RUNTIME_DEPENDENCIES / (head + ".tmp") / "node_modules"
    shutil.rmtree(dependency_temp.parent, ignore_errors=True)
    dependency_temp.mkdir(parents=True, mode=0o700)
    for source in NODE_DEPENDENCY_SOURCES:
        if not source.is_dir():
            raise RuntimeError(f"Node runtime dependency is missing: {source.name}")
        shutil.copytree(source, dependency_temp, dirs_exist_ok=True)
    (dependency_temp.parent / "package.json").write_text('{"private":true}\n', encoding="utf-8")
    remove_readonly_tree(dependency_target.parent)
    dependency_target.parent.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.replace(dependency_temp.parent, dependency_target.parent)
    python_root = dependency_target.parent / "python_modules"
    python_root.mkdir(mode=0o700)
    for source in PYTHON_DEPENDENCY_SOURCES:
        if source.is_dir():
            shutil.copytree(source, python_root / source.name, symlinks=True)
        elif source.is_file():
            shutil.copy2(source, python_root / source.name)
        else:
            raise RuntimeError(f"Python runtime dependency is missing: {source.name}")
    browser_process = subprocess.run(
        ["node", "-e", "console.log(require('playwright').chromium.executablePath())"],
        cwd=REPO, check=True, capture_output=True, text=True,
    )
    source_executable = Path(browser_process.stdout.strip()).resolve()
    source_browser_root = next((parent for parent in source_executable.parents if parent.suffix == ".app"), None)
    if source_browser_root is None:
        raise RuntimeError("Playwright Chromium bundle root cannot be resolved")
    browser_root = dependency_target.parent / "chromium" / source_browser_root.name
    shutil.copytree(source_browser_root, browser_root, symlinks=True)
    chromium_executable = browser_root / source_executable.relative_to(source_browser_root)
    for entry in sorted(dependency_target.parent.rglob("*"), reverse=True):
        if not entry.is_symlink():
            executable = bool(entry.stat().st_mode & 0o111)
            entry.chmod(0o500 if entry.is_dir() or executable else 0o400)
    dependency_target.parent.chmod(0o500)
    runtime_dependencies = {
        "nodeRoot": str(dependency_target),
        "nodeTreeSha256": tree_sha256(dependency_target),
        "pythonRoot": str(python_root),
        "pythonTreeSha256": tree_sha256(python_root),
        "browserRoot": str(browser_root),
        "browserTreeSha256": tree_sha256(browser_root),
        "chromiumExecutable": str(chromium_executable),
    }
    deployed_at = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    atomic_json(MANIFEST, {"schemaVersion": 3, "commit": head, "artifacts": source_hashes,
                           "runtimeDependencies": runtime_dependencies, "deployedAt": deployed_at})
    result = verify_runtime()
    result.update({"mode": "install-inactive", "activated": False,
                   "backupCount": len(list(BACKUP_DIR.glob("*.pre-*.py")))})
    return result


def deploy() -> dict:
    lock_path = SHARED_WORKER_LOCK
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("shared RMS worker lock is busy; deployment aborted") from exc
        return _deploy_under_lock()
    finally:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--run-scheduler", action="store_true")
    parser.add_argument("--probe-scheduler-circuit", action="store_true")
    parser.add_argument("--run-dashboard-refresh", choices=("hourly", "positions"))
    parser.add_argument("--run-auto-apply", action="store_true")
    parser.add_argument("--run-scheduler-dispatcher", action="store_true")
    parser.add_argument("--preflight-dispatcher", action="store_true")
    parser.add_argument("--canary-dispatcher", action="store_true")
    parser.add_argument("--activate-dispatcher", action="store_true")
    parser.add_argument("--verify-web-contract", action="store_true")
    parser.add_argument("--verify-health-monitor-active", action="store_true")
    args = parser.parse_args()
    try:
        if args.run_scheduler:
            return run_verified_scheduler()
        if args.probe_scheduler_circuit:
            return run_verified_scheduler(circuit_probe=True)
        if args.run_dashboard_refresh:
            return run_verified_dashboard_refresh(args.run_dashboard_refresh)
        if args.run_auto_apply:
            return run_verified_auto_apply()
        if args.run_scheduler_dispatcher:
            return run_verified_dispatcher()
        if args.preflight_dispatcher:
            print(json.dumps(run_dispatcher_preflight(), sort_keys=True))
            return 0
        if args.canary_dispatcher:
            print(json.dumps(run_dispatcher_canary(), sort_keys=True))
            return 0
        if args.activate_dispatcher:
            print(json.dumps(activate_dispatcher(), sort_keys=True))
            return 0
        if args.verify_web_contract:
            print(json.dumps(verify_web_contract(), sort_keys=True))
            return 0
        if args.verify_health_monitor_active:
            print(json.dumps(verify_health_monitor(expected_enabled=True), sort_keys=True))
            return 0
        print(json.dumps(verify_runtime() if args.verify_only else deploy(), ensure_ascii=False, sort_keys=True))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "errorCode": type(exc).__name__.upper()}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
