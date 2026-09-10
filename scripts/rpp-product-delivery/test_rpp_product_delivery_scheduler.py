import datetime as dt
import json
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

import rpp_product_delivery_scheduler as scheduler
import scripts_refresh_rpp_settings_csvs as refresh

UTC = dt.timezone.utc


def adapter_result(code, control):
    return {
        "ok": True,
        "productionChange": True,
        "rows": [{"itemCode": code, "control": control}],
        "applied": {
            "beforeReadback": [{"itemCode": code, "found": control == "d"}],
            "readback": [{"itemCode": code, "found": control == "n"}],
        },
    }


def claimed(row, claim_id):
    return {**row, "executeAt": row["executeAt"].isoformat(), "claimId": claim_id, "status": "PENDING"}


def verified_adapter(_csv_path, control, code, wal_path, operation_id):
    payload = json.loads(wal_path.read_text(encoding="utf-8"))
    if payload["operationId"] != operation_id:
        raise RuntimeError("operation mismatch")
    payload["phase"] = "VERIFIED"
    scheduler.write_wal(payload, wal_path)
    return adapter_result(code, control)


class ProductDeliverySchedulerTest(unittest.TestCase):
    def test_same_day_and_overnight_intervals_use_jst(self):
        noon_jst = dt.datetime(2026, 9, 10, 3, 0, tzinfo=UTC)
        midnight_jst = dt.datetime(2026, 9, 9, 15, 30, tzinfo=UTC)
        self.assertTrue(scheduler.interval_active(noon_jst, "10:00", "14:00"))
        self.assertFalse(scheduler.interval_active(noon_jst, "23:00", "07:00"))
        self.assertTrue(scheduler.interval_active(midnight_jst, "23:00", "07:00"))

    def test_interval_rejects_invalid_or_equal_times(self):
        now = dt.datetime(2026, 9, 10, tzinfo=UTC)
        with self.assertRaises(RuntimeError):
            scheduler.interval_active(now, "24:00", "07:00")
        with self.assertRaises(RuntimeError):
            scheduler.interval_active(now, "07:00", "07:00")

    def test_legacy_night_pause_is_active_only_0130_to_0600(self):
        at_0200 = dt.datetime(2026, 9, 9, 17, 0, tzinfo=UTC)
        at_0600 = dt.datetime(2026, 9, 9, 21, 0, tzinfo=UTC)
        self.assertEqual(scheduler.recurring_holds(at_0200, [], ["R0406"]), {"r0406"})
        self.assertEqual(scheduler.recurring_holds(at_0600, [], ["R0406"]), set())

    def test_legacy_and_custom_pause_overlap_until_the_final_hold_ends(self):
        schedule = [{"itemCode": "r0406", "enabled": True, "startTime": "23:00", "endTime": "07:00"}]
        at_0630 = dt.datetime(2026, 9, 9, 21, 30, tzinfo=UTC)
        at_0700 = dt.datetime(2026, 9, 9, 22, 0, tzinfo=UTC)
        self.assertEqual(scheduler.recurring_holds(at_0630, schedule, ["r0406"]), {"r0406"})
        self.assertEqual(scheduler.recurring_holds(at_0700, schedule, ["r0406"]), set())

    def test_payload_normalizes_and_rejects_duplicate_rows(self):
        payload = {
            "ok": True,
            "schedules": [{"itemCode": " R0406 ", "enabled": True, "startTime": "23:00", "endTime": "07:00"}],
            "reservations": [{"id": "one", "itemCode": "R0406", "action": "off", "executeAt": "2026-09-10T10:00:00+09:00", "status": "PENDING"}],
            "releaseAllowedItemCodes": ["R0406"],
        }
        schedules, reservations, release_allowed = scheduler.normalize_schedule_payload(payload)
        self.assertEqual(schedules[0]["itemCode"], "r0406")
        self.assertEqual(reservations[0]["action"], "OFF")
        self.assertEqual(release_allowed, {"r0406"})
        payload["schedules"].append(dict(payload["schedules"][0]))
        with self.assertRaises(RuntimeError):
            scheduler.normalize_schedule_payload(payload)

    def test_exclusion_snapshot_requires_exact_count_and_accepts_zero(self):
        refresh.validate_exclude_collection([], {"expected_count": 0})
        refresh.validate_exclude_collection(["r0406"], {"expected_count": 1})
        with self.assertRaises(RuntimeError):
            refresh.validate_exclude_collection([], {"expected_count": 1})
        with self.assertRaises(RuntimeError):
            refresh.validate_exclude_collection(["r0406"], {"expected_count": None})

    def test_failed_reservation_write_does_not_commit_intent(self):
        state = scheduler.default_state()
        at = dt.datetime(2026, 9, 10, 1, tzinfo=UTC)
        reservation = {"id": "off-1", "itemCode": "r0406", "action": "OFF", "executeAt": at}
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(scheduler.legacy, "_upload_path", return_value=Path(tmp) / "one.csv"), \
             patch.object(scheduler, "claim_reservation", return_value=claimed(reservation, "claim-1")), \
             patch.object(scheduler.legacy, "run_adapter", side_effect=RuntimeError("failed")):
            state_after, _, failures, completed = scheduler.process_due_reservations(
                state, [reservation], at, set(), set(), set(), True, "https://example.invalid",
                Path(tmp) / "state.json", Path(tmp) / "wal.json", Path(tmp) / "audit.jsonl")
            self.assertEqual(state_after["reservationOff"], [])
            self.assertNotIn("off-1", state_after["processedReservations"])
            self.assertEqual(completed, [])
            self.assertEqual(len(failures), 1)
            self.assertTrue((Path(tmp) / "wal.json").exists())

    def test_wal_recovery_commits_verified_rms_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path, wal_path, audit_path = Path(tmp) / "state.json", Path(tmp) / "wal.json", Path(tmp) / "audit.jsonl"
            before = scheduler.default_state()
            after = scheduler.default_state()
            after["owned"] = ["r0406"]
            scheduler.write_wal({"operationId": "op-1", "phase": "VERIFIED", "itemCode": "r0406", "control": "n", "stateBefore": before, "stateAfter": after}, wal_path)
            recovered, evidence = scheduler.recover_wal(before, {"r0406"}, state_path, wal_path, audit_path)
            self.assertEqual(recovered["owned"], ["r0406"])
            self.assertEqual(evidence["status"], "committed")
            self.assertFalse(wal_path.exists())
            self.assertEqual(scheduler.load_state(state_path)["owned"], ["r0406"])

    def test_wal_recovery_rolls_back_when_rms_does_not_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path, wal_path, audit_path = Path(tmp) / "state.json", Path(tmp) / "wal.json", Path(tmp) / "audit.jsonl"
            before = scheduler.default_state()
            after = scheduler.default_state()
            after["owned"] = ["r0406"]
            scheduler.write_wal({"operationId": "op-2", "phase": "PREPARED", "itemCode": "r0406", "control": "n", "stateBefore": before, "stateAfter": after}, wal_path)
            recovered, evidence = scheduler.recover_wal(after, {"r0406"}, state_path, wal_path, audit_path)
            self.assertEqual(recovered["owned"], [])
            self.assertEqual(evidence["status"], "rolled_back")
            self.assertFalse(wal_path.exists())

    def test_legacy_ledger_migrates_and_is_consumed_once(self):
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(scheduler.legacy, "read_ledger", return_value={"r0406"}) as read, \
             patch.object(scheduler.legacy, "write_ledger") as write:
            path = Path(tmp) / "state.json"
            state = scheduler.migrate_legacy_ledger(scheduler.default_state(), path)
            state = scheduler.migrate_legacy_ledger(state, path)
            read.assert_called_once()
            write.assert_called_once_with(set())
            self.assertTrue(state["legacyLedgerMigrated"])
            self.assertEqual(state["owned"], ["r0406"])

    def test_due_off_then_on_executes_and_verifies_each_reservation(self):
        at = dt.datetime(2026, 9, 10, 1, tzinfo=UTC)
        rows = [
            {"id": "off-1", "itemCode": "r0406", "action": "OFF", "executeAt": at - dt.timedelta(minutes=2)},
            {"id": "on-1", "itemCode": "r0406", "action": "ON", "executeAt": at - dt.timedelta(minutes=1)},
        ]
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(scheduler.legacy, "_upload_path", side_effect=[Path(tmp) / "off.csv", Path(tmp) / "on.csv"]), \
             patch.object(scheduler, "claim_reservation", side_effect=[claimed(rows[0], "claim-off"), claimed(rows[1], "claim-on")]), \
             patch.object(scheduler.legacy, "run_adapter", side_effect=verified_adapter) as adapter, \
             patch.object(scheduler, "acknowledge_reservation", return_value={"ok": True}) as ack:
            state, changes, failures, completed = scheduler.process_due_reservations(
                scheduler.default_state(), rows, at, set(), {"r0406"}, set(), True, "https://example.invalid",
                Path(tmp) / "state.json", Path(tmp) / "wal.json", Path(tmp) / "audit.jsonl")
            self.assertEqual(adapter.call_count, 2)
            self.assertEqual(ack.call_count, 2)
            self.assertEqual([row["action"] for row in changes], ["OFF", "ON"])
            self.assertEqual(completed, ["off-1", "on-1"])
            self.assertEqual(failures, [])
            self.assertEqual(state["reservationOff"], [])
            self.assertEqual(state["owned"], [])

    def test_ack_failure_retries_without_repeating_rms_write(self):
        at = dt.datetime(2026, 9, 10, 1, tzinfo=UTC)
        row = {"id": "off-1", "itemCode": "r0406", "action": "OFF", "executeAt": at}
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(scheduler.legacy, "_upload_path", return_value=Path(tmp) / "off.csv"), \
             patch.object(scheduler, "claim_reservation", return_value=claimed(row, "claim-1")), \
             patch.object(scheduler.legacy, "run_adapter", side_effect=verified_adapter) as adapter, \
             patch.object(scheduler, "acknowledge_reservation", side_effect=RuntimeError("ack failed")):
            state, _, failures, _ = scheduler.process_due_reservations(
                scheduler.default_state(), [row], at, set(), set(), set(), True, "https://example.invalid",
                Path(tmp) / "state.json", Path(tmp) / "wal.json", Path(tmp) / "audit.jsonl")
            self.assertEqual(adapter.call_count, 1)
            self.assertEqual(len(failures), 1)
        with patch.object(scheduler, "acknowledge_reservation", return_value={"ok": True}) as ack, \
             patch.object(scheduler, "_transition") as transition:
            scheduler.process_due_reservations(
                state, [row], at, set(), set(), {"r0406"}, True, "https://example.invalid",
                Path("/tmp/no-state"), Path("/tmp/no-wal"), Path("/tmp/no-audit"))
            ack.assert_called_once()
            transition.assert_not_called()

    def test_on_is_blocked_until_all_rpp_targets_are_saved(self):
        at = dt.datetime(2026, 9, 10, 1, tzinfo=UTC)
        row = {"id": "on-1", "itemCode": "r0406", "action": "ON", "executeAt": at}
        with patch.object(scheduler, "claim_reservation") as claim:
            _, changes, failures, completed = scheduler.process_due_reservations(
                scheduler.default_state(), [row], at, set(), set(), {"r0406"}, True,
                "https://example.invalid", Path("/tmp/state"), Path("/tmp/wal"), Path("/tmp/audit"))
        claim.assert_not_called()
        self.assertEqual(changes, [])
        self.assertEqual(completed, [])
        self.assertIn("目標保存", failures[0]["error"])

        owned = scheduler.default_state()
        owned["owned"] = ["r0406"]
        with tempfile.TemporaryDirectory() as tmp, patch.object(scheduler, "_transition") as transition:
            _, changes, failures = scheduler.reconcile_recurring(
                owned, set(), set(), {"r0406"}, True, Path(tmp) / "state.json", Path(tmp) / "wal.json")
        transition.assert_not_called()
        self.assertEqual(changes, [])
        self.assertIn("目標保存", failures[0]["error"])

    def test_preexisting_exclusion_is_not_owned_or_released_by_recurring_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            state, changes, failures = scheduler.reconcile_recurring(
                scheduler.default_state(), {"r0406"}, {"r0406"}, {"r0406"}, False,
                Path(tmp) / "state.json", Path(tmp) / "wal.json")
            self.assertEqual(changes, [])
            self.assertEqual(failures, [])
            self.assertEqual(state["preexisting"], ["r0406"])
            state, changes, _ = scheduler.reconcile_recurring(
                state, set(), set(), {"r0406"}, False, Path(tmp) / "state.json", Path(tmp) / "wal.json")
            self.assertEqual(changes, [])
            self.assertEqual(state["owned"], [])

    def test_production_gate_requires_flag_and_exact_confirmation(self):
        scheduler.require_gate(False, None, {})
        with self.assertRaises(RuntimeError):
            scheduler.require_gate(True, scheduler.PRODUCTION_CONFIRMATION, {})
        with self.assertRaises(RuntimeError):
            scheduler.require_gate(True, "wrong", {"RPP_ENABLE_PRODUCT_DELIVERY_SCHEDULER": "1"})

    def test_execute_acquires_lock_before_run_reads_state_or_api(self):
        events = []
        with patch.dict("os.environ", {"RPP_ENABLE_PRODUCT_DELIVERY_SCHEDULER": "1"}), \
             patch.object(scheduler.legacy, "load_env_file"), \
             patch.object(scheduler.legacy, "acquire_global_lock", side_effect=lambda: events.append("lock") or 7), \
             patch.object(scheduler.legacy, "release_global_lock"), \
             patch.object(scheduler, "run", side_effect=lambda args: events.append("run") or {"ok": True, "changes": [], "failures": [], "completedReservations": []}):
            code = scheduler.main(["--execute", "--confirm=" + scheduler.PRODUCTION_CONFIRMATION, "--quiet"])
        self.assertEqual(code, 0)
        self.assertEqual(events, ["lock", "run"])

    def test_execute_refreshes_rms_only_when_transition_or_due_action_exists(self):
        at = "2026-09-10T12:00:00+09:00"
        args = Namespace(execute=True, api_base="https://example.invalid", now=at,
                         state=Path("/tmp/state"), wal=Path("/tmp/nonexistent-rpp-wal"),
                         audit=Path("/tmp/audit"), exclude_csv=Path("/tmp/exclude"),
                         quiet=True, confirm=scheduler.PRODUCTION_CONFIRMATION)
        stable = scheduler.default_state()
        stable["legacyLedgerMigrated"] = True
        stable["owned"] = ["r0406"]
        schedule = [{"itemCode": "r0406", "enabled": True, "startTime": "10:00", "endTime": "14:00"}]
        with patch.object(scheduler, "fetch_delivery_schedules", return_value=(schedule, [], {"r0406"})), \
             patch.object(scheduler.legacy, "fetch_selection", return_value=[]), \
             patch.object(scheduler, "load_state", return_value=stable), \
             patch.object(scheduler.legacy, "read_current_exclusions", return_value={"r0406"}), \
             patch.object(scheduler, "refresh_exclusions") as refresh_call:
            scheduler.run(args)
            refresh_call.assert_not_called()
        new_state = scheduler.default_state()
        new_state["legacyLedgerMigrated"] = True
        with patch.object(scheduler, "fetch_delivery_schedules", return_value=(schedule, [], {"r0406"})), \
             patch.object(scheduler.legacy, "fetch_selection", return_value=[]), \
             patch.object(scheduler, "load_state", return_value=new_state), \
             patch.object(scheduler.legacy, "read_current_exclusions", return_value={"r0406"}), \
             patch.object(scheduler, "refresh_exclusions") as refresh_call, \
             patch.object(scheduler, "save_state"):
            scheduler.run(args)
            refresh_call.assert_called_once_with(args.exclude_csv)


if __name__ == "__main__":
    unittest.main()
