import csv
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import rpp_product_night_pause as night


class ProductNightPauseTest(unittest.TestCase):
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

    def test_verified_off_updates_ledger_and_audit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger_path = root / "ledger.json"
            audit_path = root / "audit.jsonl"
            result = {
                "ok": True,
                "productionChange": True,
                "rows": [{"control": "n", "itemCode": "r0445"}],
                "applied": {"readback": [{"itemCode": "r0445", "found": True}]},
            }
            with patch.object(night, "run_adapter", return_value=result):
                outcome = night.execute_plan(
                    "off", ["r0445"], set(), set(), ledger_path, audit_path, root / "uploads"
                )
            self.assertEqual(["r0445"], outcome["ledger"])
            self.assertEqual(["r0445"], json.loads(ledger_path.read_text())["itemCodes"])
            audit = json.loads(audit_path.read_text())
            self.assertEqual({"excluded": False}, audit["before"])
            self.assertEqual({"excluded": True}, audit["after"])
            self.assertTrue(audit["verified"])

    def test_failed_release_keeps_ledger_entry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger_path = root / "ledger.json"
            audit_path = root / "audit.jsonl"
            with patch.object(night, "run_adapter", side_effect=RuntimeError("not verified")):
                outcome = night.execute_plan(
                    "on", ["r0445"], {"r0445"}, {"r0445"}, ledger_path, audit_path, root / "uploads"
                )
            self.assertEqual(["r0445"], outcome["ledger"])
            self.assertFalse(json.loads(audit_path.read_text())["verified"])


if __name__ == "__main__":
    unittest.main()
