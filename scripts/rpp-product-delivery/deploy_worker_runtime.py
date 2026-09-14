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
import subprocess
import tempfile

REPO = Path(__file__).resolve().parents[2]
PROJECT = Path(os.environ.get("RPP_PROJECT_DIR", "/Users/nob/Projects/rpp-8am-notify"))
ARTIFACTS = {
    "scheduler": (REPO / "scripts" / "rpp-product-delivery" / "rpp_product_delivery_scheduler.py", PROJECT / "rpp_product_delivery_scheduler.py"),
    "schedulerTests": (REPO / "scripts" / "rpp-product-delivery" / "test_rpp_product_delivery_scheduler.py", PROJECT / "test_rpp_product_delivery_scheduler.py"),
    "snapshotSender": (REPO / "scripts" / "rpp-product-delivery" / "rpp_push_dashboard_snapshot.py", Path("/Users/nob/.hermes/scripts/rpp_push_dashboard_snapshot.py")),
    "snapshotSenderTests": (REPO / "scripts" / "rpp-product-delivery" / "test_rpp_push_dashboard_snapshot.py", Path("/Users/nob/.hermes/scripts/test_rpp_push_dashboard_snapshot.py")),
}
BACKUP_DIR = PROJECT / "rpp_apply_logs" / "worker_backups"
MANIFEST = PROJECT / "rpp_apply_logs" / "rpp_product_delivery_scheduler_deploy.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=REPO, text=True).strip()


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
    if not MANIFEST.is_file():
        raise RuntimeError("stable runtime deploy manifest is missing")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    actual = {}
    for name, (_, target) in ARTIFACTS.items():
        if not target.is_file():
            raise RuntimeError("stable runtime artifact is missing")
        actual[name] = sha256(target)
        if (manifest.get("artifacts") or {}).get(name) != actual[name]:
            raise RuntimeError("stable runtime SHA-256 does not match deploy manifest")
    return {"ok": True, "mode": "verify", "commit": manifest.get("commit"), "artifacts": actual}


def deploy() -> dict:
    if git("branch", "--show-current") != "main":
        raise RuntimeError("worker deploy requires main branch")
    if git("status", "--porcelain"):
        raise RuntimeError("worker deploy requires a clean working tree")
    head = git("rev-parse", "HEAD")
    if head != git("rev-parse", "origin/main"):
        raise RuntimeError("worker deploy requires HEAD to equal origin/main")
    source_hashes = {}
    for name, (source, _) in ARTIFACTS.items():
        compile(source.read_text(encoding="utf-8"), str(source), "exec")
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
    args = parser.parse_args()
    try:
        print(json.dumps(verify_runtime() if args.verify_only else deploy(), ensure_ascii=False, sort_keys=True))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "errorCode": type(exc).__name__.upper()}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
