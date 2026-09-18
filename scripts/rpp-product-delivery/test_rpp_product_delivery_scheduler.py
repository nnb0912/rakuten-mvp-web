import datetime as dt
import contextlib
import io
import hashlib
import json
import os
import subprocess
import sys
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


def verified_adapter(_csv_path, control, code, wal_path, operation_id, cancel_event=None,
                     start_gate=None, on_process_started=None):
    if on_process_started is None or start_gate is None:
        raise RuntimeError("missing gated adapter contract")
    on_process_started(987654)
    payload = json.loads(wal_path.read_text(encoding="utf-8"))
    if payload["operationId"] != operation_id:
        raise RuntimeError("operation mismatch")
    csv_bytes = Path(_csv_path).read_bytes()
    if (payload.get("csvPath") != str(Path(_csv_path).resolve())
            or payload.get("csvSha256") != hashlib.sha256(csv_bytes).hexdigest()
            or payload.get("csvBytes") != len(csv_bytes)
            or payload.get("csvRows") != [{"control": control, "itemCode": code}]):
        raise RuntimeError("CSV binding mismatch")
    payload["phase"] = "VERIFIED"
    scheduler.write_wal(payload, wal_path)
    return adapter_result(code, control)


class ProductDeliverySchedulerTest(unittest.TestCase):
    def setUp(self):
        authority = patch.object(scheduler, "require_authoritative_paths", return_value=None)
        authority.start()
        self.addCleanup(authority.stop)
        attestation = patch.object(scheduler.legacy, "require_mutation_runtime", return_value={})
        attestation.start()
        self.addCleanup(attestation.stop)
        heartbeat = patch.object(scheduler, "heartbeat_reservation", return_value={"claimId": "test-claim"})
        heartbeat.start()
        self.addCleanup(heartbeat.stop)
        release = patch.object(scheduler, "release_reservation_claim", return_value={"status": "PENDING", "claimId": None})
        self.release_claim = release.start()
        self.addCleanup(release.stop)

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

    def test_state_version_is_migrated_to_current(self):
        old = scheduler.default_state()
        old["version"] = 2
        self.assertEqual(scheduler.normalize_state(old)["version"], scheduler.STATE_VERSION)

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
        schedules, reservations, release_allowed, orphaned = scheduler.normalize_schedule_payload(payload)
        self.assertEqual(schedules[0]["itemCode"], "r0406")
        self.assertEqual(reservations[0]["action"], "OFF")
        self.assertEqual(release_allowed, {"r0406"})
        self.assertEqual(orphaned, set())
        payload["schedules"].append(dict(payload["schedules"][0]))
        with self.assertRaises(RuntimeError):
            scheduler.normalize_schedule_payload(payload)

    def test_delivery_schedule_api_requires_durable_postgres_storage(self):
        scheduler.require_durable_schedule_storage({"storage": {"source": "postgres", "durable": True}})
        for payload in ({}, {"storage": {"source": "fallback", "durable": False}},
                        {"storage": {"source": "postgres", "durable": False}}):
            with self.assertRaisesRegex(RuntimeError, "durable PostgreSQL"):
                scheduler.require_durable_schedule_storage(payload)

    def test_exclusion_snapshot_requires_exact_count_and_accepts_zero(self):
        refresh.validate_exclude_collection([], {"expected_count": 0, "collected_count": 0, "semantic_complete": True})
        refresh.validate_exclude_collection(["r0406"], {"expected_count": 1, "collected_count": 1, "semantic_complete": True})
        with self.assertRaises(RuntimeError):
            refresh.validate_exclude_collection([], {"expected_count": 1, "collected_count": 0, "semantic_complete": True})
        with self.assertRaises(RuntimeError):
            refresh.validate_exclude_collection(["r0406"], {"expected_count": None, "collected_count": 1, "semantic_complete": True})
        with self.assertRaises(RuntimeError):
            refresh.validate_exclude_collection(["unrelated-code"], {"expected_count": 1, "collected_count": 1, "semantic_complete": False})

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
            self.assertTrue(failures[0]["retryable"])
            self.assertTrue(failures[0]["claimReleased"])
            self.release_claim.assert_called_once()
            self.assertFalse((Path(tmp) / "wal.json").exists())

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
            scheduler.write_wal({"operationId": "op-2", "phase": "PREPARED", "itemCode": "r0406", "control": "n",
                                 "stateBefore": before, "stateAfter": after,
                                 "adapterStartGate": str(wal_path.with_name(wal_path.name + ".op-2.start")),
                                 "adapterPgid": None, "adapterReleasedAt": None}, wal_path)
            recovered, evidence = scheduler.recover_wal(after, {"r0406"}, state_path, wal_path, audit_path)
            self.assertEqual(recovered["owned"], [])
            self.assertEqual(evidence["status"], "rolled_back")
            self.assertFalse(wal_path.exists())

    def test_released_prepared_adapter_is_fenced_and_retained_uncertain(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state_path, wal_path, audit_path = root / "state.json", root / "wal.json", root / "audit.jsonl"
            before, after = scheduler.default_state(), scheduler.default_state()
            after["owned"] = ["r0406"]
            gate = wal_path.with_name(wal_path.name + ".op-released.start")
            gate.write_text("op-released")
            scheduler.write_wal({"operationId": "op-released", "phase": "PREPARED", "itemCode": "r0406",
                                 "control": "n", "stateBefore": before, "stateAfter": after,
                                 "adapterStartGate": str(gate), "adapterPgid": 24680,
                                 "adapterReleasedAt": "2026-09-17T00:00:00Z"}, wal_path)
            with patch.object(scheduler.os, "killpg") as killpg:
                recovered, evidence = scheduler.recover_wal(after, set(), state_path, wal_path, audit_path)
            killpg.assert_not_called()
            self.assertEqual(recovered["owned"], [])
            self.assertEqual(evidence["status"], "uncertain")
            retained = scheduler.load_wal(wal_path)
            self.assertIsNotNone(retained)
            self.assertEqual((retained or {})["phase"], "UNCERTAIN")
            self.assertFalse(gate.exists())

    def test_reused_process_group_identity_is_not_signalled(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wal_path = root / "wal.json"
            gate = root / "wal.json.op-reused.start"
            wal = {"operationId": "op-reused", "phase": "SUBMITTING", "itemCode": "r0406",
                   "control": "n", "stateBefore": scheduler.default_state(),
                   "stateAfter": scheduler.default_state(), "adapterStartGate": str(gate),
                   "adapterPgid": 24680, "adapterReleasedAt": "2026-09-17T00:00:00Z"}
            identity = subprocess.CompletedProcess([], 0, stdout="/usr/bin/unrelated-process\n", stderr="")
            with patch.object(scheduler.subprocess, "run", return_value=identity), \
                 patch.object(scheduler.os, "killpg") as killpg:
                with self.assertRaisesRegex(RuntimeError, "identity does not match"):
                    scheduler.fence_wal_adapter(wal, wal_path)
            killpg.assert_not_called()

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
        retry_row = {**row, "claimId": "claim-1", "claimExpiresAt": at - dt.timedelta(minutes=1)}
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(scheduler, "claim_reservation", return_value=claimed(row, "claim-2")) as reclaim, \
             patch.object(scheduler, "acknowledge_reservation", return_value={"ok": True}) as ack, \
             patch.object(scheduler, "_transition") as transition:
            scheduler.process_due_reservations(
                state, [retry_row], at, set(), set(), {"r0406"}, True, "https://example.invalid",
                Path(tmp) / "state.json", Path(tmp) / "wal.json", Path(tmp) / "audit.jsonl")
            reclaim.assert_called_once()
            ack.assert_called_once_with("off-1", "claim-2", "SUCCEEDED", api_base="https://example.invalid")
            transition.assert_not_called()

    def test_reservation_lease_keeper_renews_and_verifies_before_ack(self):
        with patch.object(scheduler, "heartbeat_reservation", return_value={"claimId": "claim-1"}) as heartbeat:
            keeper = scheduler.ReservationLeaseKeeper("reservation-1", "claim-1", "https://example.invalid", interval_seconds=60)
            keeper.start()
            keeper._beat()
            keeper.stop(verify=True)
            self.assertEqual(heartbeat.call_count, 3)

    def test_reservation_lease_keeper_marks_first_heartbeat_failure_as_fencing_loss(self):
        with patch.object(scheduler, "heartbeat_reservation", side_effect=[{"claimId": "claim-1"}, RuntimeError("lease lost")]):
            keeper = scheduler.ReservationLeaseKeeper("reservation-1", "claim-1", "https://example.invalid", interval_seconds=60)
            keeper.start()
            keeper._beat()
            self.assertTrue(keeper.lost_event.is_set())
            keeper.stop(verify=False)

    def test_claim_auth_failure_stops_remaining_reservations_same_tick(self):
        at = dt.datetime(2026, 9, 14, 4, 0, tzinfo=UTC)
        rows = [{"id": f"off-{index}", "itemCode": f"r{index:04d}", "action": "OFF", "executeAt": at}
                for index in range(5)]
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(scheduler, "claim_reservation", side_effect=RuntimeError("401 Unauthorized")) as claim:
            _, changes, failures, _ = scheduler.process_due_reservations(
                scheduler.default_state(), rows, at, set(), set(), set(), True, "https://example.invalid",
                Path(tmp) / "state.json", Path(tmp) / "wal.json", Path(tmp) / "audit.jsonl", max_actions=3)
            self.assertEqual(claim.call_count, 1)
            self.assertEqual(changes, [])
            self.assertEqual(len(failures), 1)
            self.assertTrue(failures[0]["blocksRms"])
            self.assertTrue(failures[0]["circuitTrip"])

    def test_cli_outer_failure_emits_compact_linked_json(self):
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(scheduler, "main", side_effect=RuntimeError("401 Unauthorized secret response")):
            output = io.StringIO()
            audit = Path(tmp) / "audit.jsonl"
            with contextlib.redirect_stdout(output):
                result = scheduler.cli(["--quiet", "--audit", str(audit), "--circuit", str(Path(tmp) / "circuit.json")])
            payload = json.loads(output.getvalue())
            self.assertEqual(result, 1)
            self.assertEqual(payload["schemaVersion"], 1)
            self.assertEqual(payload["kind"], "rppDeliveryTick")
            self.assertTrue(payload["blocked"])
            self.assertIsNone(payload["estimatedTicksRemaining"])
            self.assertEqual(payload["audit"]["tickId"], payload["tickId"])
            self.assertNotIn("secret response", output.getvalue())
            self.assertIn(payload["tickId"], audit.read_text(encoding="utf-8"))

    def test_unknown_argument_is_redacted_compact_json_without_stderr(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = io.StringIO()
            errors = io.StringIO()
            audit = Path(tmp) / "audit.jsonl"
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                result = scheduler.cli(["--audit", str(audit), "--circuit", str(Path(tmp) / "circuit.json"),
                                        "--unknown-secret=value"])
            payload = json.loads(output.getvalue())
            self.assertEqual(result, 1)
            self.assertEqual(errors.getvalue(), "")
            self.assertEqual(payload["errorCode"], "VALUEERROR")
            self.assertNotIn("unknown-secret", output.getvalue())

    def test_execute_lock_contention_emits_once_then_suppresses_for_ten_minutes(self):
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(scheduler.legacy, "load_env_file"), \
             patch.object(scheduler, "require_gate"), \
             patch.object(scheduler.legacy, "acquire_global_lock", return_value=None):
            output = io.StringIO()
            audit = Path(tmp) / "audit.jsonl"
            lock_alert = Path(tmp) / "lock-busy.json"
            argv = ["--execute", "--quiet", "--audit", str(audit),
                    "--circuit", str(Path(tmp) / "circuit.json"),
                    "--lock-busy-alert", str(lock_alert)]
            with contextlib.redirect_stdout(output):
                result = scheduler.main(argv)
            payload = json.loads(output.getvalue())
            self.assertEqual(result, 1)
            self.assertEqual(payload["errorCode"], "LOCK_BUSY")
            self.assertTrue(payload["blocked"])
            self.assertEqual(payload["audit"]["tickId"], payload["tickId"])

            repeated_output = io.StringIO()
            with contextlib.redirect_stdout(repeated_output):
                repeated_result = scheduler.main(argv)
            self.assertEqual(repeated_result, 0)
            self.assertEqual(repeated_output.getvalue(), "")
            with patch.dict(os.environ, {"RPP_EVENT_DISPATCHER": "1"}):
                self.assertEqual(scheduler.main(argv), 75)
            records = [json.loads(line) for line in audit.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(records[-1]["event"], "scheduler-lock-busy-suppressed")

    def test_lock_busy_alert_is_due_again_after_interval_and_cleared_after_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "lock-busy.json"
            first = dt.datetime(2030, 1, 1, 0, 0, tzinfo=scheduler.UTC)
            self.assertTrue(scheduler.lock_busy_notification_due(path, first))
            self.assertFalse(scheduler.lock_busy_notification_due(path, first + dt.timedelta(minutes=9)))
            self.assertTrue(scheduler.lock_busy_notification_due(path, first + dt.timedelta(minutes=10)))
            scheduler.clear_lock_busy_alert(path)
            self.assertFalse(path.exists())

    def test_lock_busy_alert_allows_only_one_concurrent_process_to_notify(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "lock-busy.json"
            module_dir = Path(__file__).resolve().parent
            code = (
                "import sys; from pathlib import Path; "
                f"sys.path.insert(0, {str(module_dir)!r}); "
                "import rpp_product_delivery_scheduler as s; "
                f"print(int(s.lock_busy_notification_due(Path({str(path)!r}), s.parse_iso('2030-01-01T00:00:00Z'))))"
            )
            processes = [subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(16)]
            results = [process.communicate(timeout=30) + (process.returncode,) for process in processes]
            self.assertTrue(all(returncode == 0 and stderr == "" for stdout, stderr, returncode in results))
            self.assertEqual(sum(int(stdout.strip()) for stdout, stderr, returncode in results), 1)

    def test_audit_rotates_at_size_limit_and_keeps_bounded_generations(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "audit.jsonl"
            for index in range(6):
                scheduler.append_audit({"index": index, "payload": "x" * 80}, path, max_bytes=1, keep=3)
            backups = list(path.parent.glob("audit.*-*.jsonl"))
            self.assertEqual(len(backups), 3)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["index"], 5)

    def test_state_history_prunes_only_old_terminal_rows_not_pending_api_ids(self):
        at = dt.datetime(2030, 2, 1, tzinfo=scheduler.UTC)
        state = scheduler.default_state()
        state["processedReservations"] = {
            "old-acked": {"status": "SUCCEEDED", "processedAt": "2029-01-01T00:00:00Z"},
            "old-pending-api": {"status": "SUCCEEDED", "processedAt": "2029-01-01T00:00:00Z"},
            "recent": {"status": "SUCCEEDED", "processedAt": "2030-01-15T00:00:00Z"},
        }
        state["occurrenceQueue"] = [
            {"occurrenceId": "old", "itemCode": "r1", "action": "OFF", "dueAt": "2029-01-01T00:00:00Z", "status": "SUCCEEDED"},
            {"occurrenceId": "pending", "itemCode": "r1", "action": "ON", "dueAt": "2029-01-01T01:00:00Z", "status": "PENDING"},
        ]
        pruned = scheduler.prune_state_history(state, [{"id": "old-pending-api"}], at)
        self.assertEqual(set(pruned["processedReservations"]), {"old-pending-api", "recent"})
        self.assertEqual([row["occurrenceId"] for row in pruned["occurrenceQueue"]], ["pending"])

    def test_on_is_blocked_until_all_rpp_targets_are_saved(self):
        at = dt.datetime(2026, 9, 10, 1, tzinfo=UTC)
        row = {"id": "on-1", "itemCode": "r0406", "action": "ON", "executeAt": at}
        with patch.object(scheduler, "claim_reservation") as claim, \
             patch.object(scheduler, "release_reservation_claim") as release:
            _, changes, failures, completed = scheduler.process_due_reservations(
                scheduler.default_state(), [row], at, set(), set(), {"r0406"}, True,
                "https://example.invalid", Path("/tmp/state"), Path("/tmp/wal"), Path("/tmp/audit"))
        claim.assert_not_called()
        release.assert_not_called()
        self.assertEqual(changes, [])
        self.assertEqual(completed, [])
        self.assertIn("目標保存", failures[0]["error"])
        self.assertTrue(failures[0]["retryable"])
        self.assertTrue(failures[0]["onGuardBlocked"])

        owned = scheduler.default_state()
        owned["owned"] = ["r0406"]
        with tempfile.TemporaryDirectory() as tmp, patch.object(scheduler, "_transition") as transition:
            _, changes, failures = scheduler.reconcile_recurring(
                owned, set(), set(), {"r0406"}, True, Path(tmp) / "state.json", Path(tmp) / "wal.json")
        transition.assert_not_called()
        self.assertEqual(changes, [])
        self.assertIn("目標保存", failures[0]["error"])

    def test_ten_due_items_drain_across_four_restarted_runs_then_release_cleanly(self):
        at = dt.datetime(2026, 9, 10, 1, tzinfo=UTC)
        codes = [f"item-{index}" for index in range(10)]
        api_pending = {
            f"off-{index}": {"id": f"off-{index}", "itemCode": code, "action": "OFF", "executeAt": at}
            for index, code in enumerate(codes)
        }
        rms_current = set()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state_path = root / "state.json"
            wal_path = root / "wal.json"
            audit_path = root / "audit.jsonl"
            exclude_csv = root / "exclude.csv"
            initial = scheduler.default_state()
            initial["legacyLedgerMigrated"] = True
            scheduler.save_state(initial, state_path)
            args = Namespace(execute=True, confirm=scheduler.PRODUCTION_CONFIRMATION,
                             api_base="https://example.invalid", state=state_path, wal=wal_path,
                             audit=audit_path, exclude_csv=exclude_csv, now=at.isoformat(), quiet=True)

            def fetch_schedules(_api_base):
                return [], list(api_pending.values()), set(codes), set()

            def claim(reservation_id, **_kwargs):
                return claimed(api_pending[reservation_id], f"claim-{reservation_id}")

            def acknowledge(reservation_id, _claim_id, status, *_args, **_kwargs):
                if status == "SUCCEEDED":
                    api_pending.pop(reservation_id, None)
                return {"ok": True, "status": status}

            adapter_phases = []

            def adapter(*adapter_args, **_adapter_kwargs):
                wal = scheduler.load_wal(adapter_args[3])
                adapter_phases.append(wal["phase"] if wal else None)
                return verified_adapter(*adapter_args, **_adapter_kwargs)

            common_patches = (
                patch.object(scheduler, "fetch_delivery_schedules", side_effect=fetch_schedules),
                patch.object(scheduler.legacy, "fetch_selection", return_value=[]),
                patch.object(scheduler, "refresh_exclusions", return_value={"ok": True}),
                patch.object(scheduler.legacy, "read_current_exclusions", side_effect=lambda _path: rms_current),
                patch.object(scheduler, "claim_reservation", side_effect=claim),
                patch.object(scheduler, "acknowledge_reservation", side_effect=acknowledge),
                patch.object(scheduler.legacy, "_upload_path", side_effect=lambda control, code: root / f"{control}-{code}.csv"),
                patch.object(scheduler.legacy, "run_adapter", side_effect=adapter),
                patch.dict("os.environ", {"RPP_SCHEDULER_MAX_ACTIONS_PER_TICK": "3"}),
            )
            for context in common_patches:
                context.start()
                self.addCleanup(context.stop)

            off_counts = []
            for _ in range(4):
                summary = scheduler.run(args)
                off_counts.append(len(summary["changes"]))
                self.assertEqual(summary["failures"], [])
                # Each call reloads state and re-fetches both API reservations and RMS state.
                self.assertEqual(scheduler.load_state(state_path)["owned"], summary["ownedAfter"])

            self.assertEqual(off_counts, [3, 3, 3, 1])
            self.assertEqual(api_pending, {})
            self.assertEqual(rms_current, set(codes))
            self.assertEqual(set(scheduler.load_state(state_path)["reservationOff"]), set(codes))

            api_pending.update({
                f"on-{index}": {"id": f"on-{index}", "itemCode": code, "action": "ON", "executeAt": at}
                for index, code in enumerate(codes)
            })
            on_counts = []
            for _ in range(4):
                summary = scheduler.run(args)
                on_counts.append(len(summary["changes"]))
                self.assertEqual(summary["failures"], [])

            final = scheduler.load_state(state_path)
            self.assertEqual(on_counts, [3, 3, 3, 1])
            self.assertEqual(api_pending, {})
            self.assertEqual(rms_current, set())
            self.assertEqual(final["owned"], [])
            self.assertEqual(final["reservationOff"], [])
            self.assertEqual(final["preexisting"], [])
            self.assertEqual(final["overrideOn"], [])
            self.assertEqual(adapter_phases, ["PREPARED"] * 20)
            self.assertFalse(wal_path.exists())

    def test_one_wal_failure_does_not_block_nine_items_and_retries_with_fixed_tick_limit(self):
        at = dt.datetime(2026, 9, 10, 1, tzinfo=UTC)
        rows = {
            f"off-{index}": {"id": f"off-{index}", "itemCode": f"item-{index}", "action": "OFF", "executeAt": at}
            for index in range(10)
        }
        rms_current = set()
        failed_once = False

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state_path = root / "state.json"
            wal_path = root / "wal.json"
            audit_path = root / "audit.jsonl"
            scheduler.save_state(scheduler.default_state(), state_path)

            def claim(reservation_id, **_kwargs):
                return claimed(rows[reservation_id], f"claim-{reservation_id}")

            def acknowledge(reservation_id, _claim_id, status, *_args, **_kwargs):
                if status == "SUCCEEDED":
                    rows.pop(reservation_id, None)
                return {"ok": True, "status": status}

            def flaky_adapter(*adapter_args, **_adapter_kwargs):
                nonlocal failed_once
                code = adapter_args[2]
                wal = scheduler.load_wal(adapter_args[3])
                if wal is None:
                    self.fail("PREPARED WAL was not created before adapter execution")
                self.assertEqual(wal["phase"], "PREPARED")
                if code == "item-0" and not failed_once:
                    failed_once = True
                    raise RuntimeError("temporary RMS failure")
                return verified_adapter(*adapter_args, **_adapter_kwargs)

            all_completed = []
            all_failures = []
            tick_counts = []
            with patch.object(scheduler, "claim_reservation", side_effect=claim), \
                 patch.object(scheduler, "acknowledge_reservation", side_effect=acknowledge), \
                 patch.object(scheduler.legacy, "_upload_path", side_effect=lambda control, code: root / f"{control}-{code}.csv"), \
                 patch.object(scheduler.legacy, "run_adapter", side_effect=flaky_adapter):
                for _ in range(4):
                    before = len(rows)
                    state = scheduler.load_state(state_path)
                    state, changes, failures, completed = scheduler.process_due_reservations(
                        state, list(rows.values()), at, set(), set(), rms_current, True,
                        "https://example.invalid", state_path, wal_path, audit_path, 3)
                    tick_counts.append(len(changes))
                    all_completed.extend(completed)
                    all_failures.extend(failures)
                    self.assertLess(len(rows), before, "fixed tick made no progress")

            self.assertEqual(tick_counts, [3, 3, 3, 1])
            self.assertEqual(rows, {})
            self.assertEqual(len(all_completed), 10)
            self.assertEqual(set(all_completed), {f"off-{index}" for index in range(10)})
            self.assertEqual([failure["reservationId"] for failure in all_failures], ["off-0"])
            self.assertTrue(all_failures[0]["retryable"])
            self.assertTrue(all_failures[0]["claimReleased"])
            self.assertEqual(set(scheduler.load_state(state_path)["owned"]), {f"item-{index}" for index in range(10)})
            self.assertEqual(rms_current, {f"item-{index}" for index in range(10)})
            self.assertFalse(wal_path.exists())

    def test_capacity_is_checked_before_claim_and_does_not_overclaim(self):
        at = dt.datetime(2026, 9, 10, 1, tzinfo=UTC)
        rows = [{"id": f"off-{i}", "itemCode": f"item-{i}", "action": "OFF", "executeAt": at} for i in range(2)]
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(scheduler, "claim_reservation", side_effect=lambda rid, **_: claimed(next(r for r in rows if r["id"] == rid), f"claim-{rid}")) as claim, \
             patch.object(scheduler, "_transition", return_value={"itemCode": "item-0", "action": "OFF", "productionChange": True}), \
             patch.object(scheduler, "acknowledge_reservation", return_value={"ok": True}):
            _, changes, _, completed = scheduler.process_due_reservations(
                scheduler.default_state(), rows, at, set(), set(), set(), True, "https://example.invalid",
                Path(tmp) / "state.json", Path(tmp) / "wal.json", Path(tmp) / "audit.jsonl", 1)
        self.assertEqual(claim.call_count, 1)
        self.assertEqual(len(changes), 1)
        self.assertEqual(completed, ["off-0"])

    def test_claim_failure_and_active_claim_do_not_block_later_reservation(self):
        at = dt.datetime(2026, 9, 10, 1, tzinfo=UTC)
        rows = [
            {"id": "busy", "itemCode": "item-a", "action": "OFF", "executeAt": at, "claimId": "other", "claimExpiresAt": at + dt.timedelta(minutes=5), "attemptCount": 2, "nextAttemptAt": "later"},
            {"id": "fails", "itemCode": "item-b", "action": "OFF", "executeAt": at},
            {"id": "works", "itemCode": "item-c", "action": "OFF", "executeAt": at},
        ]
        def claim_side_effect(reservation_id, **_):
            if reservation_id == "fails":
                raise RuntimeError("lease conflict")
            return claimed(rows[2], "claim-works")
        with tempfile.TemporaryDirectory() as tmp, patch.object(scheduler, "claim_reservation", side_effect=claim_side_effect), \
             patch.object(scheduler, "_transition", return_value={"itemCode": "item-c", "action": "OFF", "productionChange": True}), \
             patch.object(scheduler, "acknowledge_reservation", return_value={"ok": True}):
            _, changes, failures, completed = scheduler.process_due_reservations(
                scheduler.default_state(), rows, at, set(), set(), set(), True, "https://example.invalid",
                Path(tmp) / "state.json", Path(tmp) / "wal.json", Path(tmp) / "audit.jsonl")
        self.assertEqual(completed, ["works"])
        self.assertEqual(len(changes), 1)
        self.assertEqual([f["reservationId"] for f in failures], ["busy", "fails"])
        self.assertTrue(all(f["retryable"] for f in failures))

    def test_retryable_on_guard_does_not_block_later_off_or_recurring(self):
        at = dt.datetime(2026, 9, 10, 1, tzinfo=UTC)
        rows = [
            {"id": "bad-on", "itemCode": "item-a", "action": "ON", "executeAt": at},
            {"id": "good-off", "itemCode": "item-b", "action": "OFF", "executeAt": at},
        ]
        with tempfile.TemporaryDirectory() as tmp, patch.object(scheduler, "claim_reservation", side_effect=lambda rid, **_: claimed(next(row for row in rows if row["id"] == rid), "claim-" + rid)), \
             patch.object(scheduler, "_transition", return_value={"itemCode": "item-b", "action": "OFF", "productionChange": True}), \
             patch.object(scheduler, "acknowledge_reservation", return_value={"ok": True}):
            _, changes, failures, completed = scheduler.process_due_reservations(
                scheduler.default_state(), rows, at, set(), set(), {"item-a"}, True, "https://example.invalid",
                Path(tmp) / "state.json", Path(tmp) / "wal.json", Path(tmp) / "audit.jsonl")
        self.assertEqual(completed, ["good-off"])
        self.assertEqual(len(changes), 1)
        self.assertTrue(failures[0]["retryable"])
        self.assertTrue(failures[0]["onGuardBlocked"])

        owned = scheduler.default_state()
        owned["owned"] = ["item-a", "item-b"]
        with tempfile.TemporaryDirectory() as tmp, patch.object(scheduler, "_transition", return_value={"itemCode": "item-b", "action": "ON"}) as transition:
            _, recurring_changes, recurring_failures = scheduler.reconcile_recurring(
                owned, set(), {"item-b"}, {"item-a", "item-b"}, True, Path(tmp) / "state.json", Path(tmp) / "wal.json")
        self.assertEqual(len(recurring_failures), 1)
        self.assertEqual(len(recurring_changes), 1)
        transition.assert_called_once()

    def test_occurrence_queue_persists_backlog_and_marks_unstarted_off_missed(self):
        schedules = [{"itemCode": "item-a", "enabled": True, "startTime": "10:00", "endTime": "10:10"}]
        active = dt.datetime(2026, 9, 10, 1, 5, tzinfo=UTC)
        state, warnings = scheduler.sync_occurrence_queue(scheduler.default_state(), schedules, active)
        self.assertEqual(warnings, [])
        self.assertEqual([(r["action"], r["status"]) for r in state["occurrenceQueue"]], [("OFF", "PENDING"), ("ON", "PENDING")])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            scheduler.save_state(state, path)
            persisted = scheduler.load_state(path)
            ended, warnings = scheduler.sync_occurrence_queue(persisted, schedules, active + dt.timedelta(minutes=6))
        self.assertEqual([(r["action"], r["status"]) for r in ended["occurrenceQueue"]], [("OFF", "MISSED"), ("ON", "SKIPPED")])
        self.assertTrue(any("MISSED" in warning for warning in warnings))

    def test_owned_occurrence_is_restored_and_completed_after_interval(self):
        schedules = [{"itemCode": "item-a", "enabled": True, "startTime": "10:00", "endTime": "10:10"}]
        active = dt.datetime(2026, 9, 10, 1, 5, tzinfo=UTC)
        state, _ = scheduler.sync_occurrence_queue(scheduler.default_state(), schedules, active)
        state["owned"] = ["item-a"]
        state = scheduler.settle_occurrence_queue(state, {"item-a"}, active)
        self.assertEqual(state["occurrenceQueue"][0]["status"], "SUCCEEDED")
        state["owned"] = []
        ended = scheduler.settle_occurrence_queue(state, set(), active + dt.timedelta(minutes=6))
        self.assertEqual(ended["occurrenceQueue"][1]["status"], "SUCCEEDED")

    def test_submitted_wal_is_retained_uncertain_without_silent_off_ownership(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path, wal_path, audit_path = Path(tmp) / "state.json", Path(tmp) / "wal.json", Path(tmp) / "audit.jsonl"
            before = scheduler.default_state()
            after = scheduler.default_state()
            after["owned"] = ["item-a"]
            scheduler.write_wal({"operationId": "op-u", "phase": "SUBMITTED", "itemCode": "item-a", "control": "n",
                                 "beforeExcluded": False, "stateBefore": before, "stateAfter": after}, wal_path)
            recovered, evidence = scheduler.recover_wal(after, set(), state_path, wal_path, audit_path)
            self.assertEqual(evidence["status"], "uncertain")
            self.assertEqual(recovered["owned"], [])
            self.assertEqual(recovered["preexisting"], [])
            self.assertEqual(scheduler.load_wal(wal_path)["phase"], "UNCERTAIN")

    def test_submitted_wal_fresh_matching_transition_remains_uncertain(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path, wal_path, audit_path = Path(tmp) / "state.json", Path(tmp) / "wal.json", Path(tmp) / "audit.jsonl"
            before = scheduler.default_state()
            after = scheduler.default_state()
            after["owned"] = ["item-a"]
            scheduler.write_wal({"operationId": "op-r", "phase": "SUBMITTED", "submittedAt": "2026-09-10T01:00:00Z", "itemCode": "item-a", "control": "n",
                                 "beforeExcluded": False, "stateBefore": before, "stateAfter": after}, wal_path)
            with patch.object(scheduler, "refresh_exclusions"), \
                 patch.object(scheduler.legacy, "read_current_exclusions", side_effect=[set(), {"item-a"}]), \
                 patch.object(scheduler.time, "sleep"), \
                 patch.dict("os.environ", {"RPP_WAL_RECOVERY_SECONDS": "180", "RPP_WAL_RECOVERY_POLL_SECONDS": "1"}):
                recovered, evidence, current = scheduler.recover_wal_with_fresh_readback(
                    before, set(), state_path, wal_path, audit_path, Path(tmp) / "exclude.csv")
            self.assertEqual(evidence["status"], "uncertain")
            self.assertTrue(evidence["freshReadback"])
            self.assertEqual(current, {"item-a"})
            self.assertEqual(recovered["owned"], [])
            self.assertEqual(scheduler.load_wal(wal_path)["phase"], "UNCERTAIN")

    def test_action_limit_is_bounded(self):
        with patch.dict("os.environ", {"RPP_SCHEDULER_MAX_ACTIONS_PER_TICK": "99"}):
            self.assertEqual(scheduler.max_actions_per_tick(), 3)
        with patch.dict("os.environ", {"RPP_SCHEDULER_MAX_ACTIONS_PER_TICK": "0"}):
            self.assertEqual(scheduler.max_actions_per_tick(), 1)

    def test_notification_summary_is_compact_and_reports_bounded_rollout_eta(self):
        summary = {
            "tickId": "tick-1",
            "observedAt": "2026-09-14T02:36:06Z",
            "ok": True,
            "dryRun": False,
            "changes": [{"itemCode": "item-a", "action": "OFF", "productionChange": True,
                         "readback": [{"textSample": "x" * 5000}]}],
            "failures": [],
            "completedReservations": ["reservation-secret-id"],
            "activeRecurring": ["item-a"],
            "desiredOff": ["item-a"],
            "ownedAfter": ["item-a"],
            "preexistingAfter": [],
            "queueDepth": 7,
            "maxActionsPerTick": 3,
            "warnings": [],
            "walRecovery": {"status": "none"},
        }
        compact = scheduler.notification_summary(summary, Path("/tmp/full-audit.jsonl"))
        self.assertNotIn("readback", compact["changes"][0])
        self.assertNotIn("completedReservations", compact)
        self.assertEqual(compact["completedReservationCount"], 1)
        self.assertEqual(compact["rolloutPolicy"]["mode"], "BOUNDED_CANARY")
        self.assertEqual(compact["estimatedTicksRemaining"], 3)
        self.assertEqual(compact["estimatedCompletionMinutes"], 3)
        self.assertEqual(compact["schemaVersion"], 1)
        self.assertEqual(compact["tickId"], "tick-1")
        self.assertEqual(compact["earliestCompletionAt"], "2026-09-14T02:39:06Z")
        self.assertEqual(compact["audit"], {"path": "/tmp/full-audit.jsonl", "tickId": "tick-1"})
        self.assertLess(len(json.dumps(compact, ensure_ascii=False)), 1500)

    def test_event_dispatcher_receives_guard_backlog_even_when_operator_alert_is_suppressed(self):
        summary = {
            "tickId": "tick", "observedAt": "2026-09-17T00:00:00Z", "ok": False,
            "dryRun": False, "changes": [], "failures": [{"itemCode": "r1", "onGuardBlocked": True,
            "retryable": True, "error": "guard"}], "completedReservations": [], "activeRecurring": [],
            "desiredOff": [], "ownedAfter": ["r1"], "preexistingAfter": [], "queueDepth": 1,
            "maxActionsPerTick": 3, "warnings": [], "walRecovery": {"status": "none"},
            "blocked": True, "guardBlockedItems": ["r1"],
        }
        with tempfile.TemporaryDirectory() as tmp, \
             patch.dict(os.environ, {"RPP_ENABLE_PRODUCT_DELIVERY_SCHEDULER": "1", "RPP_EVENT_DISPATCHER": "1"}), \
             patch.object(scheduler.legacy, "load_env_file"), \
             patch.object(scheduler.legacy, "acquire_global_lock", return_value=object()), \
             patch.object(scheduler.legacy, "release_global_lock"), \
             patch.object(scheduler, "load_circuit", return_value={"open": False}), \
             patch.object(scheduler, "reset_circuit"), \
             patch.object(scheduler, "update_on_guard_alerts", return_value={"notify": False, "resolved": False}), \
             patch.object(scheduler, "append_audit"), \
             patch.object(scheduler, "run", return_value=summary):
            output = io.StringIO()
            root = Path(tmp)
            with contextlib.redirect_stdout(output):
                result = scheduler.main(["--execute", "--confirm=" + scheduler.PRODUCTION_CONFIRMATION,
                                         "--state", str(root / "state.json"), "--wal", str(root / "wal.json"),
                                         "--audit", str(root / "audit.jsonl"), "--circuit", str(root / "circuit.json"),
                                         "--on-guard-alert", str(root / "guard.json"),
                                         "--lock-busy-alert", str(root / "lock.json")])
            receipt = json.loads(output.getvalue())
            self.assertEqual(result, 0)
            self.assertEqual(receipt["kind"], "rppDeliveryTick")
            self.assertEqual(receipt["queueDepth"], 1)

    def test_repeated_external_failure_opens_circuit_and_only_opener_notifies(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "circuit.json"
            first = scheduler.record_external_failure(RuntimeError("schedule API failed: timed out after 45 seconds"), path, threshold=3)
            second = scheduler.record_external_failure(RuntimeError("schedule API failed: timed out after 99 seconds"), path, threshold=3)
            third = scheduler.record_external_failure(RuntimeError("schedule API failed: timed out after 12 seconds"), path, threshold=3)
            fourth = scheduler.record_external_failure(RuntimeError("schedule API failed: timed out after 88 seconds"), path, threshold=3)
            self.assertEqual([first["consecutive"], second["consecutive"], third["consecutive"]], [1, 2, 3])
            self.assertFalse(first["open"])
            self.assertFalse(second["open"])
            self.assertTrue(third["open"])
            self.assertTrue(third["notify"])
            self.assertTrue(fourth["open"])
            self.assertFalse(fourth["notify"])
            self.assertTrue(scheduler.load_circuit(path)["open"])

    def test_captcha_opens_circuit_immediately_and_reset_requires_explicit_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "circuit.json"
            opened = scheduler.record_external_failure(RuntimeError("RMS CAPTCHA challenge detected"), path, threshold=3)
            self.assertTrue(opened["open"])
            self.assertEqual(opened["category"], "CAPTCHA")
            self.assertTrue(opened["notify"])
            scheduler.reset_circuit(path)
            self.assertFalse(scheduler.load_circuit(path)["open"])

    def test_non_external_business_guard_does_not_open_circuit(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "circuit.json"
            result = scheduler.record_external_failure(RuntimeError("広告ONには全RPP設定行への目標保存が必要です"), path)
            self.assertEqual(result["status"], "ignored")
            self.assertFalse(path.exists())

    def test_on_guard_alert_notifies_once_until_resolved(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "guard.json"
            first = scheduler.update_on_guard_alerts({"item-a"}, path)
            repeated = scheduler.update_on_guard_alerts({"item-a"}, path)
            expanded = scheduler.update_on_guard_alerts({"item-a", "item-b"}, path)
            resolved = scheduler.update_on_guard_alerts(set(), path)
            self.assertTrue(first["notify"])
            self.assertFalse(repeated["notify"])
            self.assertTrue(expanded["notify"])
            self.assertEqual(expanded["newItemCodes"], ["item-b"])
            self.assertTrue(resolved["resolved"])
            self.assertFalse(path.exists())

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
        with tempfile.TemporaryDirectory() as tmp, \
             patch.dict("os.environ", {"RPP_ENABLE_PRODUCT_DELIVERY_SCHEDULER": "1"}), \
             patch.object(scheduler.legacy, "load_env_file"), \
             patch.object(scheduler.legacy, "acquire_global_lock", side_effect=lambda: events.append("lock") or 7), \
             patch.object(scheduler.legacy, "release_global_lock"), \
             patch.object(scheduler, "run", side_effect=lambda args: events.append("run") or {"ok": True, "changes": [], "failures": [], "completedReservations": []}):
            root = Path(tmp)
            code = scheduler.main(["--execute", "--confirm=" + scheduler.PRODUCTION_CONFIRMATION, "--quiet",
                                   "--circuit", str(root / "circuit.json"),
                                   "--lock-busy-alert", str(root / "lock-busy.json")])
        self.assertEqual(code, 0)
        self.assertEqual(events, ["lock", "run"])

    def test_open_circuit_skips_run_but_prioritizes_existing_wal_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            circuit = root / "circuit.json"
            wal = root / "wal.json"
            scheduler.atomic_json_write({"open": True, "category": "AUTH", "signature": "auth", "consecutive": 1}, circuit)
            wal.write_text("{}", encoding="utf-8")
            with patch.dict("os.environ", {"RPP_ENABLE_PRODUCT_DELIVERY_SCHEDULER": "1"}), \
                 patch.object(scheduler.legacy, "load_env_file"), \
                 patch.object(scheduler.legacy, "acquire_global_lock", return_value=7), \
                 patch.object(scheduler.legacy, "release_global_lock"), \
                 patch.object(scheduler, "recover_wal_while_circuit_open", return_value={"status": "uncertain"}) as recover, \
                 patch.object(scheduler, "run") as run_call:
                code = scheduler.main(["--execute", "--confirm=" + scheduler.PRODUCTION_CONFIRMATION,
                                       "--circuit", str(circuit), "--wal", str(wal),
                                       "--audit", str(root / "audit.jsonl"), "--quiet"])
            self.assertEqual(code, 0)
            recover.assert_called_once()
            run_call.assert_not_called()

    def test_circuit_probe_is_read_only_and_clears_open_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            circuit = root / "circuit.json"
            scheduler.atomic_json_write({"open": True, "category": "NETWORK", "signature": "net", "consecutive": 3}, circuit)
            with patch.dict("os.environ", {"RPP_ENABLE_PRODUCT_DELIVERY_SCHEDULER": "1"}), \
                 patch.object(scheduler.legacy, "load_env_file"), \
                 patch.object(scheduler.legacy, "acquire_global_lock", return_value=7), \
                 patch.object(scheduler.legacy, "release_global_lock"), \
                 patch.object(scheduler, "probe_external_dependencies", return_value={"exclusionCount": 10}) as probe, \
                 patch.object(scheduler, "run") as run_call:
                code = scheduler.main(["--circuit-probe", "--confirm=" + scheduler.CIRCUIT_PROBE_CONFIRMATION,
                                       "--circuit", str(circuit), "--wal", str(root / "wal.json"), "--quiet"])
            self.assertEqual(code, 0)
            probe.assert_called_once()
            run_call.assert_not_called()
            self.assertFalse(circuit.exists())

    def test_execute_refreshes_rms_only_when_transition_or_due_action_exists(self):
        at = "2026-09-10T12:00:00+09:00"
        args = Namespace(execute=True, api_base="https://example.invalid", now=at,
                         state=Path("/tmp/state"), wal=Path("/tmp/nonexistent-rpp-wal"),
                         audit=Path("/tmp/audit"), exclude_csv=Path("/tmp/exclude"),
                         quiet=True, confirm=scheduler.PRODUCTION_CONFIRMATION)
        stable = scheduler.default_state()
        stable["legacyLedgerMigrated"] = True
        stable["owned"] = ["r0406"]
        stable["lastRmsSnapshotAt"] = scheduler.iso_utc(scheduler.parse_iso(at))
        schedule = [{"itemCode": "r0406", "enabled": True, "startTime": "10:00", "endTime": "14:00"}]
        with patch.object(scheduler, "fetch_delivery_schedules", return_value=(schedule, [], {"r0406"}, set())), \
             patch.object(scheduler.legacy, "fetch_selection", return_value=[]), \
             patch.object(scheduler, "load_state", return_value=stable), \
             patch.object(scheduler.legacy, "read_current_exclusions", return_value={"r0406"}), \
             patch.object(scheduler, "refresh_exclusions") as refresh_call:
            scheduler.run(args)
            refresh_call.assert_not_called()
        new_state = scheduler.default_state()
        new_state["legacyLedgerMigrated"] = True
        with patch.object(scheduler, "fetch_delivery_schedules", return_value=(schedule, [], {"r0406"}, set())), \
             patch.object(scheduler.legacy, "fetch_selection", return_value=[]), \
             patch.object(scheduler, "load_state", return_value=new_state), \
             patch.object(scheduler.legacy, "read_current_exclusions", return_value={"r0406"}), \
             patch.object(scheduler, "refresh_exclusions") as refresh_call, \
             patch.object(scheduler, "save_state"):
            scheduler.run(args)
            refresh_call.assert_called_once_with(args.exclude_csv)

    def test_open_circuit_prepared_wal_rolls_back_without_external_readback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state_path, wal_path, audit_path = root / "state.json", root / "wal.json", root / "audit.jsonl"
            before = scheduler.default_state()
            after = scheduler.default_state()
            after["owned"] = ["item-a"]
            scheduler.save_state(after, state_path)
            scheduler.write_wal({"version": 3, "operationId": "op-1", "phase": "PREPARED",
                                 "createdAt": "2026-09-14T00:00:00Z", "itemCode": "item-a", "control": "n",
                                 "beforeExcluded": False, "reservationId": None,
                                 "stateBefore": before, "stateAfter": after,
                                 "adapterStartGate": str(wal_path.with_name(wal_path.name + ".op-1.start")),
                                 "adapterPgid": None, "adapterReleasedAt": None}, wal_path)
            args = Namespace(state=state_path, wal=wal_path, audit=audit_path, exclude_csv=root / "exclude.csv")
            with patch.object(scheduler, "refresh_exclusions") as refresh_call:
                evidence = scheduler.recover_wal_while_circuit_open(args)
            self.assertEqual(evidence["status"], "rolled_back")
            self.assertFalse(wal_path.exists())
            self.assertEqual(scheduler.load_state(state_path)["owned"], [])
            refresh_call.assert_not_called()

    def test_auth_or_challenge_stops_remaining_reservations_in_same_tick(self):
        at = dt.datetime(2026, 9, 14, 0, 0, tzinfo=UTC)
        reservations = [{"id": f"res-{index}", "itemCode": f"item-{index}", "action": "OFF",
                         "executeAt": at, "attemptCount": 0, "nextAttemptAt": None}
                        for index in range(5)]
        state = scheduler.default_state()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def claimed(reservation_id, api_base=None):
                row = next(item for item in reservations if item["id"] == reservation_id)
                return {**row, "executeAt": scheduler.iso_utc(row["executeAt"]), "claimId": "claim-" + reservation_id}
            with patch.object(scheduler, "claim_reservation", side_effect=claimed), \
                 patch.object(scheduler, "heartbeat_reservation"), \
                 patch.object(scheduler, "release_reservation_claim"), \
                 patch.object(scheduler, "_transition", side_effect=RuntimeError('{"errorCode":"RMS_CHALLENGE"}')) as transition:
                _, _, failures, _ = scheduler.process_due_reservations(
                    state, reservations, at, set(), set(), set(), True, "https://example.invalid",
                    root / "state.json", root / "wal.json", root / "audit.jsonl", 3)
            self.assertEqual(transition.call_count, 1)
            self.assertEqual(len(failures), 1)
            self.assertTrue(failures[0]["blocksRms"])
            self.assertTrue(failures[0]["circuitTrip"])

    def test_adapter_probe_uses_non_submitting_dom_path(self):
        result = {"ok": True, "productionChange": False,
                  "applied": {"finalSubmitSkipped": True, "finalUploadButtonPresent": True,
                              "beforeReadback": [{"itemCode": "item-a", "found": False}]}}
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(scheduler.legacy, "write_one_row_csv"), \
             patch.object(scheduler.subprocess, "run", return_value=Namespace(returncode=0, stdout=json.dumps(result), stderr="")) as run_call:
            evidence = scheduler.probe_rms_adapter_dom("item-a", False, Path(tmp))
        command = run_call.call_args.args[0]
        self.assertIn("--execute", command)
        self.assertNotIn("--final-submit", command)
        self.assertTrue(evidence["uploadDomVerified"])
        self.assertFalse(evidence["productionChange"])


if __name__ == "__main__":
    unittest.main()
