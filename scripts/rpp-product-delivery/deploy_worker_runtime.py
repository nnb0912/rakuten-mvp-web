#!/usr/bin/env python3
"""Atomically deploy and verify the stable RPP delivery worker."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request

REPO = Path(__file__).resolve().parents[2]
PROJECT = Path(os.environ.get("RPP_PROJECT_DIR", "/Users/nob/Projects/rpp-8am-notify"))
ARTIFACTS = {
    "scheduler": (REPO / "scripts" / "rpp-product-delivery" / "rpp_product_delivery_scheduler.py", PROJECT / "rpp_product_delivery_scheduler.py"),
    "schedulerTests": (REPO / "scripts" / "rpp-product-delivery" / "test_rpp_product_delivery_scheduler.py", PROJECT / "test_rpp_product_delivery_scheduler.py"),
    "nightPause": (REPO / "scripts" / "rpp-product-delivery" / "rpp_product_night_pause.py", PROJECT / "rpp_product_night_pause.py"),
    "nightPauseTests": (REPO / "scripts" / "rpp-product-delivery" / "test_rpp_product_night_pause.py", PROJECT / "test_rpp_product_night_pause.py"),
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
    "runtimeManifestTests": (REPO / "scripts" / "rpp-product-delivery" / "test_rpp_runtime_manifest.py", PROJECT / "test_rpp_runtime_manifest.py"),
    "deployVerifier": (REPO / "scripts" / "rpp-product-delivery" / "deploy_worker_runtime.py", PROJECT / "deploy_worker_runtime.py"),
}
BACKUP_DIR = PROJECT / "rpp_apply_logs" / "worker_backups"
MANIFEST = PROJECT / "rpp_apply_logs" / "rpp_product_delivery_scheduler_deploy.json"
API_BASE = os.environ.get("RPP_DASHBOARD_URL", "https://rakuten-mvp-web.onrender.com").rstrip("/")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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
    value = os.environ.get("RPP_SNAPSHOT_SYNC_TOKEN", "").strip()
    if value:
        return value
    result = subprocess.run(["security", "find-generic-password", "-s", "hermes.rpp.snapshot-sync", "-w"], text=True, capture_output=True)
    if result.returncode or not result.stdout.strip():
        raise RuntimeError("RPP snapshot sync token is unavailable")
    return result.stdout.strip()


def verify_web_contract() -> dict:
    request = urllib.request.Request(
        f"{API_BASE}/api/rpp/sync-snapshot?resource=contract",
        headers={"Authorization": f"Bearer {snapshot_token()}", "Accept": "application/json", "User-Agent": "rise-rpp-runtime-deploy/1.0"},
    )
    with urllib.request.urlopen(request, timeout=45) as response:
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
    return {"ok": True, "mode": "verify", "commit": manifest.get("commit"), "artifacts": actual}


def run_verified_scheduler() -> int:
    manifest = json.loads(stable_bytes(MANIFEST).decode("utf-8"))
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
        env = os.environ.copy()
        env["PYTHONPATH"] = str(generation)
        env["RPP_SETTINGS_REFRESH_SCRIPT"] = str(generation / ARTIFACTS["settingsRefresh"][1].name)
        process = subprocess.run([sys.executable, str(scheduler), "--execute", "--confirm=RPP_PRODUCT_DELIVERY_SCHEDULER"], env=env, text=True, capture_output=True)
        if process.stdout:
            print(process.stdout, end="")
        if process.stderr:
            print(process.stderr, end="", file=sys.stderr)
        return process.returncode


def run_verified_dashboard_refresh(mode: str) -> int:
    manifest = json.loads(stable_bytes(MANIFEST).decode("utf-8"))
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
        env = os.environ.copy()
        env.update({
            "PYTHONPATH": str(generation),
            "RPP_PROJECT_DIR": str(PROJECT),
            "NODE_PATH": str(PROJECT / "node_modules"),
            "RPP_SETTINGS_REFRESH_SCRIPT": str(generation / ARTIFACTS["settingsRefresh"][1].name),
            "RPP_SNAPSHOT_SENDER": str(generation / ARTIFACTS["snapshotSender"][1].name),
            "RPP_RECOMMENDATION_SCRIPT": str(generation / ARTIFACTS["recommendationGenerator"][1].name),
            "RPP_POSITION_MONITOR_SCRIPT": str(generation / ARTIFACTS["positionMonitor"][1].name),
        })
        recommendation = generation / ARTIFACTS["recommendationGenerator"][1].name
        preflight = subprocess.run(["node", str(recommendation), "--runtime-preflight"], cwd=PROJECT, env=env, text=True, capture_output=True)
        if preflight.returncode != 0:
            raise RuntimeError("recommendation private-generation preflight failed")
        orchestrator = generation / ARTIFACTS["dashboardRefreshOrchestrator"][1].name
        process = subprocess.run([sys.executable, str(orchestrator), mode], env=env, text=True, capture_output=True)
        if process.stdout:
            print(process.stdout, end="")
        if process.stderr:
            print(process.stderr, end="", file=sys.stderr)
        return process.returncode


def deploy() -> dict:
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
        elif source.suffix == ".js":
            subprocess.run(["node", "--check", str(source)], check=True, capture_output=True, text=True)
        source_hashes[name] = sha256(source)
    PROJECT.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for name, (source, target) in ARTIFACTS.items():
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
    deployed_at = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    atomic_json(MANIFEST, {"schemaVersion": 2, "commit": head, "artifacts": source_hashes, "deployedAt": deployed_at})
    result = verify_runtime()
    result.update({"mode": "deploy", "backupCount": len(list(BACKUP_DIR.glob("*.pre-*.py")))})
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--run-scheduler", action="store_true")
    parser.add_argument("--run-dashboard-refresh", choices=("hourly", "positions"))
    parser.add_argument("--verify-web-contract", action="store_true")
    args = parser.parse_args()
    try:
        if args.run_scheduler:
            return run_verified_scheduler()
        if args.run_dashboard_refresh:
            return run_verified_dashboard_refresh(args.run_dashboard_refresh)
        if args.verify_web_contract:
            print(json.dumps(verify_web_contract(), sort_keys=True))
            return 0
        print(json.dumps(verify_runtime() if args.verify_only else deploy(), ensure_ascii=False, sort_keys=True))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "errorCode": type(exc).__name__.upper()}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
