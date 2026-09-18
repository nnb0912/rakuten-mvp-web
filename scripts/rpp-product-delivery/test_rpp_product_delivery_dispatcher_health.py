import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import rpp_product_delivery_dispatcher_health as health

LAUNCHD_OK = """program = /usr/bin/python3
arguments = {
    /usr/bin/python3
    -s
    /Users/nob/Projects/rpp-8am-notify/deploy_worker_runtime.py
    --run-scheduler-dispatcher
}
environment = {
    HOME => /Users/nob
    PATH => /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
    RPP_PROJECT_DIR => /Users/nob/Projects/rpp-8am-notify
    RPP_EVENT_DISPATCHER => 1
    PYTHONNOUSERSITE => 1
}
state = running
pid = 1234
"""


class DispatcherHealthTest(unittest.TestCase):
    def test_healthy_service_is_silent_success(self):
        now = dt.datetime.now(dt.timezone.utc)
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(health, "HEARTBEAT", Path(tmp) / "heartbeat.json"), \
             patch.object(health, "STATE", Path(tmp) / "state.json"), \
             patch.object(health, "WAL", Path(tmp) / "wal.json"), \
             patch.object(health, "AUTO_APPLY_WAL", Path(tmp) / "auto-wal.json"), \
             patch.object(health, "CIRCUIT", Path(tmp) / "circuit.json"), \
             patch.object(health.subprocess, "run", side_effect=[
                 SimpleNamespace(returncode=0, stdout=json.dumps({"commit": "a" * 40})),
                 SimpleNamespace(returncode=0, stdout=LAUNCHD_OK),
             ]):
            health.HEARTBEAT.write_text(json.dumps({"ok": True, "at": now.isoformat(), "reason": "waiting",
                                                    "listenerConnected": True, "manifestCommit": "a" * 40, "pid": 1234}))
            health.STATE.write_text(json.dumps({"reason": "listener-connected"}))
            self.assertEqual(0, health.main())

    def test_persistent_lock_is_failure(self):
        now = dt.datetime.now(dt.timezone.utc)
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(health, "HEARTBEAT", Path(tmp) / "heartbeat.json"), \
             patch.object(health, "STATE", Path(tmp) / "state.json"), \
             patch.object(health, "WAL", Path(tmp) / "wal.json"), \
             patch.object(health, "AUTO_APPLY_WAL", Path(tmp) / "auto-wal.json"), \
             patch.object(health, "CIRCUIT", Path(tmp) / "circuit.json"), \
             patch.object(health.subprocess, "run", side_effect=[
                 SimpleNamespace(returncode=0, stdout=json.dumps({"commit": "a" * 40})),
                 SimpleNamespace(returncode=0, stdout=LAUNCHD_OK),
             ]):
            health.HEARTBEAT.write_text(json.dumps({"ok": True, "at": now.isoformat(), "reason": "lock-retry",
                                                    "listenerConnected": True, "manifestCommit": "a" * 40, "pid": 1234}))
            health.STATE.write_text(json.dumps({"reason": "lock-retry",
                                                "firstLockBusyAt": (now - dt.timedelta(minutes=11)).isoformat(),
                                                "firstRetryAt": (now - dt.timedelta(minutes=11)).isoformat()}))
            self.assertEqual(1, health.main())

    def test_fresh_startup_retry_heartbeat_is_unhealthy(self):
        now = dt.datetime.now(dt.timezone.utc)
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(health, "HEARTBEAT", Path(tmp) / "heartbeat.json"), \
             patch.object(health, "STATE", Path(tmp) / "state.json"), \
             patch.object(health, "WAL", Path(tmp) / "wal.json"), \
             patch.object(health, "AUTO_APPLY_WAL", Path(tmp) / "auto-wal.json"), \
             patch.object(health, "CIRCUIT", Path(tmp) / "circuit.json"), \
             patch.object(health.subprocess, "run", side_effect=[
                 SimpleNamespace(returncode=0, stdout=json.dumps({"commit": "a" * 40})),
                 SimpleNamespace(returncode=0, stdout=LAUNCHD_OK),
             ]):
            health.HEARTBEAT.write_text(json.dumps({"ok": False, "at": now.isoformat(),
                                                    "reason": "startup-retry", "listenerConnected": True,
                                                    "manifestCommit": "a" * 40}))
            health.STATE.write_text(json.dumps({"reason": "startup-retry", "firstFailureAt": now.isoformat()}))
            self.assertEqual(1, health.main())

    def test_auto_apply_unresolved_wal_is_failure(self):
        now = dt.datetime.now(dt.timezone.utc)
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(health, "HEARTBEAT", Path(tmp) / "heartbeat.json"), \
             patch.object(health, "STATE", Path(tmp) / "state.json"), \
             patch.object(health, "WAL", Path(tmp) / "wal.json"), \
             patch.object(health, "AUTO_APPLY_WAL", Path(tmp) / "auto-wal.json"), \
             patch.object(health, "CIRCUIT", Path(tmp) / "circuit.json"), \
             patch.object(health.subprocess, "run", side_effect=[
                 SimpleNamespace(returncode=0, stdout=json.dumps({"commit": "a" * 40})),
                 SimpleNamespace(returncode=0, stdout=LAUNCHD_OK),
             ]):
            health.HEARTBEAT.write_text(json.dumps({"ok": True, "at": now.isoformat(), "reason": "waiting",
                                                    "listenerConnected": True, "manifestCommit": "a" * 40, "pid": 1234}))
            health.STATE.write_text(json.dumps({"reason": "listener-connected"}))
            health.AUTO_APPLY_WAL.write_text(json.dumps({"version": 1, "entries": [{"state": "SUBMITTING"}]}))
            self.assertEqual(1, health.main())

    def test_stale_or_nonrunning_launchd_definition_is_failure(self):
        with patch.object(health.subprocess, "run", side_effect=[
            SimpleNamespace(returncode=0, stdout=json.dumps({"commit": "a" * 40})),
            SimpleNamespace(returncode=0, stdout="program = /tmp/stale\nstate = exited\npid = 0\n"),
        ]):
            self.assertEqual(1, health.main())


if __name__ == "__main__":
    unittest.main()
