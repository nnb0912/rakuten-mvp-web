import csv
import json
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import rpp_product_night_pause as night


class ProductNightPauseTest(unittest.TestCase):
    def test_runtime_and_adapter_paths_ignore_hostile_environment_overrides(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            commit = "a" * 40
            runtime = project / "runtime_dependencies" / commit
            browser = runtime / "chromium" / "Chromium.app"
            manifest = project / "rpp_apply_logs" / "rpp_product_delivery_scheduler_deploy.json"
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({"commit": commit, "runtimeDependencies": {
                "nodeRoot": str(runtime / "node_modules"), "nodeTreeSha256": "1" * 64,
                "browserRoot": str(browser), "browserTreeSha256": "2" * 64,
                "chromiumExecutable": str(browser / "Contents" / "MacOS" / "Chromium")}}))
            hostile = {"RPP_EXCLUSION_NODE_BIN": "/tmp/node", "RPP_EXCLUSION_WORKER_LOCK": "/tmp/other",
                       "RPP_RMS_PROFILE_DIR": "/tmp/profile", "RMS_LOGIN_PASS": "hostile"}
            with patch.object(night, "PROJECT", project), patch.dict(night.os.environ, hostile):
                runtime_env = night.attested_runtime_environment()
            self.assertEqual(runtime_env["RPP_PLAYWRIGHT_NODE_ROOT"], str((runtime / "node_modules").resolve()))
            self.assertEqual(night.NODE_BIN, "/opt/homebrew/bin/node")
            self.assertEqual(night.LOCK_PATH, Path("/tmp/rise-rpp-exclusion-worker.lock"))
            self.assertNotIn("RMS_LOGIN_PASS", runtime_env)

    def test_adapter_process_is_terminated_when_reservation_lease_is_lost(self):
        class FakeProcess:
            pid = 4321
            returncode = -15
            calls = 0

            def communicate(self, timeout=None):
                self.calls += 1
                if self.calls == 1:
                    raise subprocess.TimeoutExpired("adapter", float(timeout or 1))
                return "", ""

        with tempfile.TemporaryDirectory() as tmp:
            adapter = Path(tmp) / "adapter.mjs"
            adapter.write_text("// test")
            cancelled = threading.Event()
            cancelled.set()
            process = FakeProcess()
            with patch.object(night, "ADAPTER", adapter), \
                 patch.object(night, "require_mutation_runtime", return_value={}), \
                 patch.object(night, "WEB_PROJECT", Path(tmp)), \
                 patch.object(night, "trusted_env_values", return_value={"RMS_LOGIN_ID": "id", "RMS_LOGIN_PASS": "pass", "RAKUTEN_EMAIL": "mail", "RAKUTEN_EMAIL_PASS": "pass"}), \
                 patch.object(night, "attested_runtime_environment", return_value={"RPP_RUNTIME_COMMIT": "a" * 40}), \
                 patch.object(night.subprocess, "Popen", return_value=process), \
                 patch.object(night.os, "killpg") as killpg:
                with self.assertRaisesRegex(RuntimeError, "lease was lost"):
                    night.run_adapter(Path(tmp) / "input.csv", "n", "r0445",
                                      wal_path=Path(tmp) / "wal.json", operation_id="op-1",
                                      cancel_event=cancelled, start_gate=Path(tmp) / "gate",
                                      on_process_started=lambda _pid: None)
                killpg.assert_called_once_with(4321, night.signal.SIGTERM)

    def test_adapter_gate_opens_only_after_wal_process_registration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            adapter = root / "adapter.mjs"
            adapter.write_text("// test")
            gate = root / "start.gate"
            events = []

            class FakeProcess:
                pid = 5555
                returncode = 0

                def communicate(self, timeout=None):
                    self.assert_gate()
                    return json.dumps({
                        "ok": True, "productionChange": True,
                        "rows": [{"control": "n", "itemCode": "r0445"}],
                        "applied": {
                            "beforeReadback": [{"itemCode": "r0445", "found": False}],
                            "readback": [{"itemCode": "r0445", "found": True}],
                        },
                    }), ""

                def assert_gate(self):
                    events.append(("communicate", gate.exists(), gate.read_text()))

            def register(pid):
                events.append(("registered", pid, gate.exists()))

            with patch.object(night, "ADAPTER", adapter), \
                 patch.object(night, "require_mutation_runtime", return_value={}), \
                 patch.object(night, "WEB_PROJECT", root), \
                 patch.object(night, "trusted_env_values", return_value={"RMS_LOGIN_ID": "id", "RMS_LOGIN_PASS": "pass", "RAKUTEN_EMAIL": "mail", "RAKUTEN_EMAIL_PASS": "pass"}), \
                 patch.object(night, "attested_runtime_environment", return_value={"RPP_RUNTIME_COMMIT": "a" * 40}), \
                 patch.object(night.subprocess, "Popen", return_value=FakeProcess()) as popen:
                night.run_adapter(root / "input.csv", "n", "r0445", root / "wal.json", "op-1",
                                  start_gate=gate, on_process_started=register)
            capability = popen.call_args.kwargs["env"]["RPP_ADAPTER_CAPABILITY"]
            self.assertGreaterEqual(len(capability), 32)
            self.assertEqual(events, [("registered", 5555, False), ("communicate", True, f"op-1:{capability}")])
            self.assertIn(f"--start-gate={gate}", popen.call_args.args[0])
            self.assertFalse(gate.exists())

    def test_selection_normalization_is_distinct_sorted_and_lowercase(self):
        payload = {"ok": True, "itemCodes": [" R0445 ", "c017", "r0445", "", " C017 "]}
        self.assertEqual(["c017", "r0445"], night.normalize_selection(payload))

    def test_selection_rejects_invalid_contract_or_code(self):
        with self.assertRaisesRegex(RuntimeError, "ok=true"):
            night.normalize_selection({"ok": False, "itemCodes": []})
        with self.assertRaisesRegex(RuntimeError, "itemCodes"):
            night.normalize_selection({"ok": True, "itemCodes": "r0445"})
        with self.assertRaisesRegex(RuntimeError, "invalid item code"):
            night.normalize_selection({"ok": True, "itemCodes": ["=formula"]})

    def test_off_plan_skips_preexisting_exclusions(self):
        plan = night.plan_off(["c017", "r0445", "r0550"], {"c017", "other"})
        self.assertEqual(["r0445", "r0550"], plan["apply"])
        self.assertEqual(["c017"], plan["preexisting"])

    def test_on_plan_restores_ledger_scope_only(self):
        plan = night.plan_on({"r0445", "c017", "already-active"}, {"r0445", "c017", "manual-exclusion"})
        self.assertEqual(["c017", "r0445"], plan["apply"])
        self.assertEqual(["already-active"], plan["alreadyActive"])
        self.assertNotIn("manual-exclusion", plan["apply"])

    def test_read_current_exclusions_normalizes_cp932_csv(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "exclude.csv"
            with path.open("w", encoding="cp932", newline="") as handle:
                writer = csv.writer(handle, lineterminator="\r\n")
                writer.writerow(["商品管理番号"])
                writer.writerow([" R0445 "])
                writer.writerow(["c017"])
            self.assertEqual({"c017", "r0445"}, night.read_current_exclusions(path))

    def test_one_row_csv_is_cp932_with_exact_control_and_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "one.csv"
            night.write_one_row_csv(path, "n", "r0445")
            with path.open("r", encoding="cp932", newline="") as handle:
                rows = list(csv.reader(handle))
            self.assertEqual([["コントロールカラム", "商品管理番号"], ["n", "r0445"]], rows)

    def test_production_gate_requires_env_and_confirmation(self):
        night.require_production_gate(False, None, {})
        with self.assertRaisesRegex(RuntimeError, "RPP_ENABLE_PRODUCT_NIGHT_PAUSE=1"):
            night.require_production_gate(True, night.PRODUCTION_CONFIRMATION, {})
        with self.assertRaisesRegex(RuntimeError, "--confirm"):
            night.require_production_gate(True, "wrong", {"RPP_ENABLE_PRODUCT_NIGHT_PAUSE": "1"})
        night.require_production_gate(
            True,
            night.PRODUCTION_CONFIRMATION,
            {"RPP_ENABLE_PRODUCT_NIGHT_PAUSE": "1"},
        )

    def test_adapter_requires_exact_before_and_after_readback(self):
        result = {
            "ok": True,
            "productionChange": True,
            "rows": [{"control": "n", "itemCode": "r0445"}],
            "applied": {
                "beforeReadback": [{"itemCode": "r0445", "found": False}],
                "readback": [{"itemCode": "r0445", "found": True}],
            },
        }
        night.verify_adapter_result(result, "n", "r0445")
        del result["applied"]["beforeReadback"]
        with self.assertRaisesRegex(RuntimeError, "precondition"):
            night.verify_adapter_result(result, "n", "r0445")

    def test_legacy_direct_production_execution_is_disabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(night, "run_adapter") as adapter:
                with self.assertRaisesRegex(RuntimeError, "WAL-backed delivery scheduler"):
                    night.execute_plan("off", ["r0445"], set(), set(),
                                       root / "ledger.json", root / "audit.jsonl", root / "uploads")
            adapter.assert_not_called()


if __name__ == "__main__":
    unittest.main()
