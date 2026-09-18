import datetime as dt
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import rpp_product_delivery_dispatcher as dispatcher

UTC = dt.timezone.utc


class ProductDeliveryDispatcherTest(unittest.TestCase):
    def setUp(self):
        runtime = patch.object(dispatcher, "require_private_generation", return_value=None)
        runtime.start()
        self.addCleanup(runtime.stop)

    def test_deployment_preflight_receipt_is_normalized_for_activation_probe(self):
        receipt = dispatcher.parse_scheduler_receipt('{"kind":"rppDeliveryDeploymentPreflight","ok":true,"productionChange":false}\n')
        self.assertIsNotNone(receipt)
        self.assertTrue((receipt or {})["deploymentProbe"])

    def test_activation_probe_arm_exposes_armed_reason(self):
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(dispatcher, "STATE_PATH", Path(tmp) / "state.json"), \
             patch.object(dispatcher, "HEARTBEAT_PATH", Path(tmp) / "heartbeat.json"):
            dispatcher.persist_arm(self.snapshot(), None, "activation-probe")
            payload = json.loads((Path(tmp) / "heartbeat.json").read_text())
            self.assertEqual(payload["armedReason"], "activation-probe")

    def test_scheduler_invocation_stays_inside_private_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            scheduler = root / "rpp_product_delivery_scheduler.py"
            scheduler.write_text("# immutable test scheduler\n")
            receipt_dir = root / "rpp_apply_logs"
            receipt_dir.mkdir()
            python_root = root / "python_modules"
            python_root.mkdir()
            python_hash = "3" * 64
            receipt_dir.joinpath("rpp_product_delivery_scheduler_deploy.json").write_text(
                json.dumps({"runtimeDependencies": {"pythonRoot": str(python_root), "pythonTreeSha256": python_hash}}))
            receipt_dir.joinpath("rpp_product_delivery_dispatcher_activation.json").write_text(
                json.dumps({"activated": True, "commit": "a" * 40}))
            completed = subprocess.CompletedProcess([], 0, stdout='{"kind":"rppDeliveryTick","ok":true}\n', stderr='')
            with patch.object(dispatcher, "PROJECT", root), patch.object(dispatcher, "SCHEDULER", scheduler), \
                 patch.object(dispatcher, "RUNTIME_COMMIT", "a" * 40), \
                 patch.dict(os.environ, {"RPP_PYTHON_PLAYWRIGHT_ROOT": str(python_root),
                                         "RPP_PYTHON_PLAYWRIGHT_TREE_SHA256": python_hash}), \
                 patch.object(dispatcher.subprocess, "run", return_value=completed) as run:
                code, receipt, _ = dispatcher.invoke_scheduler()
            self.assertEqual(code, 0)
            self.assertEqual(receipt, {"kind": "rppDeliveryTick", "ok": True})
            command = run.call_args.args[0]
            self.assertEqual(command[1], "-s")
            self.assertEqual(command[2], str(scheduler))
            self.assertNotIn("/bin/bash", command)
            self.assertEqual(run.call_args.kwargs["env"]["PYTHONPATH"], os.pathsep.join((str(root), str(python_root))))
            self.assertEqual(run.call_args.kwargs["env"]["PYTHONNOUSERSITE"], "1")

            with patch.object(dispatcher, "PROJECT", root), \
                 patch.dict(os.environ, {"RPP_PYTHON_PLAYWRIGHT_ROOT": str(python_root),
                                         "RPP_PYTHON_PLAYWRIGHT_TREE_SHA256": "4" * 64}):
                with self.assertRaisesRegex(RuntimeError, "contract mismatch"):
                    dispatcher.pinned_python_root()

    def snapshot(self, now="2026-09-17T00:00:00Z", generation=7, schedules=None, reservations=None):
        return {
            "ok": True,
            "storage": {"source": "postgres", "durable": True},
            "generation": generation,
            "serverNow": now,
            "schedules": schedules or [],
            "reservations": reservations or [],
        }

    def test_next_deadline_uses_recurring_jst_boundaries(self):
        value = self.snapshot(
            now="2026-09-17T00:00:00Z",
            schedules=[{"itemCode": "r0445", "enabled": True, "startTime": "23:00", "endTime": "07:00"}],
        )
        self.assertEqual(dispatcher.next_deadline(value), dt.datetime(2026, 9, 17, 14, 0, tzinfo=UTC))
        value["serverNow"] = "2026-09-17T15:00:00Z"
        self.assertEqual(dispatcher.next_deadline(value), dt.datetime(2026, 9, 17, 22, 0, tzinfo=UTC))

    def test_overdue_reservation_is_armed_immediately(self):
        value = self.snapshot(
            now="2026-09-17T00:00:00Z",
            reservations=[{"id": "x", "status": "PENDING", "executeAt": "2026-09-16T23:00:00Z"}],
        )
        self.assertEqual(dispatcher.next_deadline(value), dt.datetime(2026, 9, 17, 0, 0, tzinfo=UTC))

    def test_non_pending_reservation_fails_closed(self):
        value = self.snapshot(
            reservations=[{"id": "x", "status": "SUCCEEDED", "executeAt": "2026-09-17T01:00:00Z"}],
        )
        with self.assertRaisesRegex(RuntimeError, "non-PENDING"):
            dispatcher.next_deadline(value)

    def test_run_once_uses_short_retry_only_for_lock_contention(self):
        value = self.snapshot()
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(dispatcher, "STATE_PATH", Path(tmp) / "state.json"), \
             patch.object(dispatcher, "HEARTBEAT_PATH", Path(tmp) / "heartbeat.json"), \
             patch.object(dispatcher, "invoke_scheduler", return_value=(75, None, "LOCK_BUSY")), \
             patch.object(dispatcher, "fetch_snapshot", return_value=value):
            snapshot, deadline = dispatcher.run_once("test")
            self.assertEqual(snapshot["generation"], 7)
            self.assertEqual(deadline, dt.datetime(2026, 9, 17, 0, 1, tzinfo=UTC))
            self.assertEqual(json.loads((Path(tmp) / "state.json").read_text())["reason"], "lock-retry")

    def test_run_once_recognizes_current_worker_lock_busy_receipt(self):
        value = self.snapshot()
        receipt = {"kind": "rppDeliveryTick", "ok": False, "errorCode": "LOCK_BUSY"}
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(dispatcher, "STATE_PATH", Path(tmp) / "state.json"), \
             patch.object(dispatcher, "HEARTBEAT_PATH", Path(tmp) / "heartbeat.json"), \
             patch.object(dispatcher, "invoke_scheduler", return_value=(1, receipt, "LOCK_BUSY")), \
             patch.object(dispatcher, "fetch_snapshot", return_value=value):
            _, deadline = dispatcher.run_once("test")
            self.assertEqual(deadline, dt.datetime(2026, 9, 17, 0, 1, tzinfo=UTC))

    def test_run_once_retries_only_while_backlog_exists(self):
        value = self.snapshot()
        receipt = {"kind": "rppDeliveryTick", "ok": True, "queueDepth": 2}
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(dispatcher, "STATE_PATH", Path(tmp) / "state.json"), \
             patch.object(dispatcher, "HEARTBEAT_PATH", Path(tmp) / "heartbeat.json"), \
             patch.object(dispatcher, "invoke_scheduler", return_value=(0, receipt, "")), \
             patch.object(dispatcher, "fetch_snapshot", return_value=value):
            _, deadline = dispatcher.run_once("test")
            self.assertEqual(deadline, dt.datetime(2026, 9, 17, 0, 1, tzinfo=UTC))

    def test_run_once_rejects_success_without_machine_receipt(self):
        value = self.snapshot()
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(dispatcher, "STATE_PATH", Path(tmp) / "state.json"), \
             patch.object(dispatcher, "HEARTBEAT_PATH", Path(tmp) / "heartbeat.json"), \
             patch.object(dispatcher, "invoke_scheduler", return_value=(0, None, "")), \
             patch.object(dispatcher, "fetch_snapshot", return_value=value):
            with self.assertRaisesRegex(RuntimeError, "machine receipt required"):
                dispatcher.run_once("test")

    def test_overdue_pending_without_receipt_fails_for_bounded_daemon_retry(self):
        value = self.snapshot(reservations=[
            {"id": "x", "status": "PENDING", "executeAt": "2026-09-16T23:00:00Z"},
        ])
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(dispatcher, "STATE_PATH", Path(tmp) / "state.json"), \
             patch.object(dispatcher, "HEARTBEAT_PATH", Path(tmp) / "heartbeat.json"), \
             patch.object(dispatcher, "invoke_scheduler", return_value=(0, None, "")), \
             patch.object(dispatcher, "fetch_snapshot", return_value=value):
            with self.assertRaisesRegex(RuntimeError, "machine receipt required"):
                dispatcher.run_once("test")

    def test_startup_scheduler_failure_is_armed_inside_daemon_not_raised(self):
        value = self.snapshot()
        stops = iter([False, True])
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(dispatcher, "STATE_PATH", Path(tmp) / "state.json"), \
             patch.object(dispatcher, "HEARTBEAT_PATH", Path(tmp) / "heartbeat.json"), \
             patch.object(dispatcher, "run_once", side_effect=RuntimeError("blocked")), \
             patch.object(dispatcher, "fetch_snapshot", return_value=value), \
             patch.object(dispatcher, "connect_listener", side_effect=RuntimeError("offline")), \
             patch.object(dispatcher.time, "sleep"):
            dispatcher.serve(lambda: next(stops))
            armed = json.loads(dispatcher.STATE_PATH.read_text())
            self.assertEqual(armed["reason"], "startup-retry")
            self.assertEqual(armed["deadline"], "2026-09-17T00:01:00Z")

    def test_repeated_suppressed_lock_keeps_first_observed_time(self):
        value = self.snapshot()
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(dispatcher, "STATE_PATH", Path(tmp) / "state.json"), \
             patch.object(dispatcher, "HEARTBEAT_PATH", Path(tmp) / "heartbeat.json"), \
             patch.object(dispatcher, "invoke_scheduler", return_value=(75, None, "")), \
             patch.object(dispatcher, "fetch_snapshot", return_value=value):
            dispatcher.run_once("first")
            first = json.loads(dispatcher.STATE_PATH.read_text())["firstLockBusyAt"]
            dispatcher.run_once("second")
            second = json.loads(dispatcher.STATE_PATH.read_text())
            self.assertEqual(second["reason"], "lock-retry")
            self.assertEqual(second["firstLockBusyAt"], first)

    def test_retry_reason_change_preserves_first_retry_time(self):
        value = self.snapshot()
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(dispatcher, "STATE_PATH", Path(tmp) / "state.json"), \
             patch.object(dispatcher, "HEARTBEAT_PATH", Path(tmp) / "heartbeat.json"):
            dispatcher.persist_arm(value, dt.datetime(2026, 9, 17, 0, 1, tzinfo=UTC), "lock-retry")
            first = json.loads(dispatcher.STATE_PATH.read_text())["firstRetryAt"]
            dispatcher.persist_arm(value, dt.datetime(2026, 9, 17, 0, 2, tzinfo=UTC), "backlog-retry")
            self.assertEqual(json.loads(dispatcher.STATE_PATH.read_text())["firstRetryAt"], first)

    def test_listener_connection_preserves_active_lock_retry_arm(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(dispatcher, "STATE_PATH", Path(tmp) / "state.json"):
            dispatcher.STATE_PATH.write_text(json.dumps({"reason": "lock-retry", "firstLockBusyAt": "2026-09-17T00:00:00Z"}))
            self.assertTrue(dispatcher.retry_arm_is_active(dt.datetime(2026, 9, 17, 0, 1, tzinfo=UTC)))
            self.assertFalse(dispatcher.retry_arm_is_active(None))

    def test_restart_preserves_future_durable_retry_without_invoking_scheduler(self):
        value = self.snapshot()
        stops = iter([False, True])
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(dispatcher, "STATE_PATH", Path(tmp) / "state.json"), \
             patch.object(dispatcher, "HEARTBEAT_PATH", Path(tmp) / "heartbeat.json"), \
             patch.object(dispatcher, "RUNTIME_COMMIT", "a" * 40), \
             patch.object(dispatcher, "fetch_snapshot", return_value=value), \
             patch.object(dispatcher, "run_once") as run_once:
            dispatcher.STATE_PATH.write_text(json.dumps({"reason": "backlog-retry", "generation": 7,
                "manifestCommit": "a" * 40, "deadline": "2026-09-17T00:01:00Z",
                "firstRetryAt": "2026-09-17T00:00:00Z"}))
            dispatcher.serve(lambda: next(stops))
            run_once.assert_not_called()
            self.assertEqual(json.loads(dispatcher.STATE_PATH.read_text())["deadline"], "2026-09-17T00:01:00Z")

    def test_listener_dsn_rejects_wrong_host_or_weak_tls(self):
        good = "postgresql://user:***@dpg-da5bpibncjis738eh9bg-a.singapore-postgres.render.com:5432/rakuten_mvp_web?sslmode=verify-full&sslrootcert=%2Fetc%2Fssl%2Fcert.pem"
        psycopg = MagicMock()
        psycopg.extensions.parse_dsn.return_value = {
            "host": dispatcher.EXPECTED_DB_HOST, "port": "5432", "dbname": dispatcher.EXPECTED_DB_NAME,
            "user": "user", "password": "***", "sslmode": "verify-full", "sslrootcert": "/etc/ssl/cert.pem",
        }
        psycopg.extensions.make_dsn.return_value = "rebuilt-safe-dsn"
        original_psycopg = dispatcher.psycopg2
        dispatcher.psycopg2 = psycopg
        self.addCleanup(setattr, dispatcher, "psycopg2", original_psycopg)
        with patch.object(dispatcher, "keychain_secret", return_value=good):
            effective = dispatcher.psycopg2.extensions.parse_dsn(dispatcher.listener_dsn())
            self.assertEqual(effective["host"], dispatcher.EXPECTED_DB_HOST)
            self.assertEqual(effective["dbname"], dispatcher.EXPECTED_DB_NAME)
        with patch.object(dispatcher, "keychain_secret", return_value=good.replace("sslmode=verify-full", "sslmode=require")):
            with self.assertRaisesRegex(RuntimeError, "target/TLS"):
                dispatcher.listener_dsn()
        with patch.object(dispatcher, "keychain_secret", return_value=good.replace("&sslrootcert=%2Fetc%2Fssl%2Fcert.pem", "")):
            with self.assertRaisesRegex(RuntimeError, "target/TLS"):
                dispatcher.listener_dsn()
        with patch.object(dispatcher, "keychain_secret", return_value=good.replace("dpg-da5bpibncjis738eh9bg-a", "evil")):
            with self.assertRaisesRegex(RuntimeError, "target/TLS"):
                dispatcher.listener_dsn()
        for suffix in (
            "&host=evil.example.com", "&hostaddr=127.0.0.1", "&port=6432", "&dbname=evil",
            "#host=evil.example.com", "&sslmode=verify-full", "&application_name=evil",
        ):
            with self.subTest(suffix=suffix), patch.object(dispatcher, "keychain_secret", return_value=good + suffix):
                with self.assertRaisesRegex(RuntimeError, "target/TLS"):
                    dispatcher.listener_dsn()
        with patch.object(dispatcher, "keychain_secret", return_value=good.replace("/rakuten_mvp_web?", "//rakuten_mvp_web?")):
            with self.assertRaisesRegex(RuntimeError, "target/TLS"):
                dispatcher.listener_dsn()

    def test_generation_and_server_time_validation_helpers(self):
        with self.assertRaisesRegex(RuntimeError, "timezone"):
            dispatcher.parse_iso("2026-09-17T00:00:00", "serverNow")
        self.assertEqual(dispatcher.parse_hhmm("23:59"), (23, 59))
        with self.assertRaisesRegex(RuntimeError, "HH:mm"):
            dispatcher.parse_hhmm("24:00")


if __name__ == "__main__":
    unittest.main()
