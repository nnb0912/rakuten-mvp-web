import csv
import datetime as dt
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import rpp_allowed_auto_apply as auto


class AllowedAutoApplyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.uploads = self.root / "uploads"
        self.wal = self.root / "wal.json"
        self.audit = self.root / "audit.jsonl"
        self.patches = [
            patch.object(auto, "UPLOAD_DIR", self.uploads),
            patch.object(auto, "WAL_PATH", self.wal),
            patch.object(auto, "AUDIT_PATH", self.audit),
        ]
        for item in self.patches:
            item.start()
        self.settings = {"enabled": True, "autoApplyEnabled": True}

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.tmp.cleanup()

    def rec(self, item="r0445", source="商品CPC", keyword="商品CPC", action="LOWER", mode="ROAS"):
        return {
            "itemCode": item, "itemName": "fixture", "source": source, "keyword": keyword,
            "optimizationMode": mode, "action": action, "currentCpc": 30, "proposedCpc": 20,
            "uploadReady": True, "blocks": [], "reasons": ["fixture reason"],
        }

    def target_payload(self, targets):
        normalized = [{"changeLocked": False, "protectionType": "NORMAL", **row} for row in targets]
        return {"source": "https://rakuten-mvp-web.onrender.com/api/rpp/sync-snapshot?resource=targets", "targets": normalized}

    def write_targets(self, targets):
        path = self.root / "targets.json"
        path.write_text(json.dumps(self.target_payload(targets)), encoding="utf-8")
        return path

    def test_selected_automatic_modes_and_fixed_drift(self):
        fixed = self.rec("r0406", mode="FIXED")
        data = {"recommendations": [self.rec(), self.rec("c017"), fixed]}
        eligible, skipped = auto.eligible_recommendations(data, self.settings)
        self.assertEqual(["r0406", "c017", "r0445"], [row["itemCode"] for row in eligible])
        self.assertEqual("FIXED_SYNC", auto.change_type(eligible[0]))
        self.assertEqual([], skipped)

    def test_current_targets_are_unique_https_and_strictly_parsed(self):
        valid = {"itemCode": "r0001", "keyword": "商品CPC", "optimizationMode": "FIXED", "fixedCpc": 60}
        loaded = auto.load_current_targets(self.write_targets([valid]))
        self.assertEqual(60, loaded[("r0001", "")]["fixedCpc"])
        with self.assertRaisesRegex(RuntimeError, "duplicate current target"):
            auto.load_current_targets(self.write_targets([valid, valid]))
        bad_source = self.target_payload([valid])
        bad_source["source"] = "file:///tmp/targets.json"
        path = self.root / "bad-source.json"
        path.write_text(json.dumps(bad_source), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "configured HTTPS sync URL"):
            auto.load_current_targets(path)
        with self.assertRaisesRegex(RuntimeError, "invalid configured fixedCpc"):
            auto.load_current_targets(self.write_targets([{**valid, "fixedCpc": "bad"}]))
        for non_integer in (60.9, "60", True):
            with self.assertRaisesRegex(RuntimeError, "invalid configured fixedCpc"):
                auto.load_current_targets(self.write_targets([{**valid, "fixedCpc": non_integer}]))
        with patch.dict(auto.os.environ, {"RPP_TARGETS_URL": "https://attacker.invalid/targets"}):
            with self.assertRaisesRegex(RuntimeError, "override is forbidden"):
                auto.load_current_targets(self.write_targets([valid]))

    def test_fixed_uses_current_config_not_recommendation_authority(self):
        target = {"itemCode": "r0001", "keyword": "商品CPC", "optimizationMode": "FIXED", "fixedCpc": 60}
        targets = auto.load_current_targets(self.write_targets([target]))
        rec = self.rec("r0001", mode="FIXED", action="RAISE")
        rec["currentCpc"], rec["proposedCpc"] = 50, 61
        with self.assertRaisesRegex(RuntimeError, "does not equal configured fixedCpc"):
            auto.validate_recommendations_against_targets({"recommendations": [rec]}, targets)
        rec["proposedCpc"] = 60
        auto.validate_recommendations_against_targets({"recommendations": [rec]}, targets)
        rec["proposedCpc"] = 60.9
        with self.assertRaisesRegex(RuntimeError, "proposedCpc must be a JSON integer"):
            auto.validate_recommendations_against_targets({"recommendations": [rec]}, targets)

    def test_fixed_hold_with_null_proposal_is_validated_but_never_eligible(self):
        target = {"itemCode": "r0606", "keyword": "商品CPC", "optimizationMode": "FIXED", "fixedCpc": 20}
        targets = auto.load_current_targets(self.write_targets([target]))
        rec = self.rec("r0606", mode="FIXED", action="HOLD")
        rec["currentCpc"], rec["proposedCpc"], rec["uploadReady"] = 20, None, False
        auto.validate_recommendations_against_targets({"recommendations": [rec]}, targets)
        eligible, skipped = auto.eligible_recommendations({"recommendations": [rec]}, self.settings)
        self.assertEqual([], eligible)
        self.assertEqual("action is not RAISE/LOWER", skipped[0]["reason"])
        for malformed in ("20", -1, 20, {}, []):
            with self.assertRaisesRegex(RuntimeError, "must be null"):
                auto.validate_recommendations_against_targets({"recommendations": [{**rec, "proposedCpc": malformed}]}, targets)

    def test_duplicate_recommendations_and_invalid_sources_fail_whole_tick(self):
        target = {"itemCode": "r0001", "keyword": "商品CPC", "optimizationMode": "ROAS"}
        targets = auto.load_current_targets(self.write_targets([target]))
        rec = self.rec("r0001")
        with self.assertRaisesRegex(RuntimeError, "duplicate recommendation"):
            auto.validate_recommendations_against_targets({"recommendations": [rec, rec]}, targets)
        with self.assertRaisesRegex(RuntimeError, "invalid recommendation source"):
            auto.validate_recommendations_against_targets({"recommendations": [{**rec, "source": "other"}]}, targets)

    def test_recommendation_contract_and_direction_fail_closed(self):
        target = {"itemCode": "r0001", "keyword": "商品CPC", "optimizationMode": "ROAS"}
        targets = auto.load_current_targets(self.write_targets([target]))
        rec = self.rec("r0001")
        with self.assertRaisesRegex(RuntimeError, "reasons contract"):
            auto.validate_recommendations_against_targets({"recommendations": [{**rec, "reasons": None}]}, targets)
        with self.assertRaisesRegex(RuntimeError, "blocks contract"):
            auto.validate_recommendations_against_targets({"recommendations": [{**rec, "blocks": None}]}, targets)
        wrong_direction = {**rec, "action": "RAISE", "currentCpc": 60, "proposedCpc": 20}
        with self.assertRaisesRegex(RuntimeError, "action direction"):
            auto.validate_recommendations_against_targets({"recommendations": [wrong_direction]}, targets)

    def test_fresh_operator_lock_or_blocked_protection_stops_whole_tick(self):
        rec = self.rec("r0001")
        blocked_targets = (
            {"changeLocked": True, "protectionType": "LOCKED"},
            {"changeLocked": False, "protectionType": "BLOCK"},
            {"changeLocked": None, "protectionType": "NORMAL"},
            {"changeLocked": False, "protectionType": None},
        )
        for fields in blocked_targets:
            target = {"itemCode": "r0001", "keyword": "商品CPC", "optimizationMode": "ROAS", **fields}
            targets = auto.load_current_targets(self.write_targets([target]))
            with self.assertRaisesRegex(RuntimeError, "current target"):
                auto.validate_recommendations_against_targets({"recommendations": [rec]}, targets)

    def test_recommendation_source_and_current_mode_must_match_target(self):
        target = {"itemCode": "r0001", "keyword": "収納", "optimizationMode": "POSITION"}
        targets = auto.load_current_targets(self.write_targets([target]))
        rec = self.rec("r0001", "キーワードCPC", "収納", mode="ROAS")
        with self.assertRaisesRegex(RuntimeError, "mode does not match"):
            auto.validate_recommendations_against_targets({"recommendations": [rec]}, targets)

    def test_max_changes_per_tick_has_hard_cap_three(self):
        with patch.dict(auto.os.environ, {"RPP_AUTO_APPLY_MAX_CHANGES": "3"}):
            self.assertEqual(3, auto.max_changes_per_tick())
        with patch.dict(auto.os.environ, {"RPP_AUTO_APPLY_MAX_CHANGES": "4"}):
            with self.assertRaisesRegex(RuntimeError, "between 1 and 3"):
                auto.max_changes_per_tick()

    def test_hold_or_blocked_is_never_applied(self):
        hold = self.rec(action="HOLD")
        hold["proposedCpc"] = None
        blocked = self.rec("r0406")
        blocked["blocks"] = ["データ不足"]
        eligible, _ = auto.eligible_recommendations({"recommendations": [hold, blocked]}, self.settings)
        self.assertEqual([], eligible)

    def test_auto_apply_flag_is_required(self):
        eligible, skipped = auto.eligible_recommendations({"recommendations": [self.rec()]}, {**self.settings, "autoApplyEnabled": False})
        self.assertEqual([], eligible)
        self.assertEqual("autoApplyEnabled is false", skipped[0]["reason"])

    def test_bundle_names_are_collision_safe_and_contents_are_exact(self):
        now = dt.datetime(2026, 9, 8, 10, 5, 6, tzinfo=auto.JST)
        first = auto.write_bundle(self.rec(), "tick-a", "tick-a:1:aaa", now)
        second = auto.write_bundle(self.rec(), "tick-b", "tick-b:1:bbb", now)
        self.assertNotEqual(first["upload"], second["upload"])
        with first["upload"].open(encoding="cp932", newline="") as handle:
            upload = list(csv.reader(handle))
        with first["rollback"].open(encoding="cp932", newline="") as handle:
            rollback = list(csv.reader(handle))
        self.assertEqual(["u", "r0445", "20"], upload[1])
        self.assertEqual(["u", "r0445", "30"], rollback[1])

    def test_wal_is_fsynced_state_machine_and_unresolved_blocks_resend(self):
        operation = {"operationId": "op-1", "tickId": "tick-1", "itemCode": "r1"}
        auto.prepare_wal(operation, self.wal)
        self.assertEqual("PREPARED", auto.wal_state("op-1", self.wal))
        self.assertEqual(1, len(auto.unresolved_wal_entries(self.wal)))
        for state in ("SUBMITTING", "SUBMITTED", "VERIFIED"):
            auto.transition_wal("op-1", state, path=self.wal)
            self.assertEqual(state, auto.wal_state("op-1", self.wal))
        self.assertEqual([], auto.unresolved_wal_entries(self.wal))
        with self.assertRaisesRegex(RuntimeError, "illegal auto-apply WAL transition"):
            auto.transition_wal("op-1", "SUBMITTING", path=self.wal)
        self.assertEqual([], auto.unresolved_wal_entries(self.wal))

    def test_shared_lock_contention_is_audited_and_nonzero(self):
        lock = self.root / "shared.lock"
        audit = self.root / "subprocess-audit.jsonl"
        fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            code = (
                "import rpp_allowed_auto_apply as m; "
                f"m.LOCK_PATH=__import__('pathlib').Path({str(lock)!r}); "
                f"m.AUDIT_PATH=__import__('pathlib').Path({str(audit)!r}); "
                "raise SystemExit(m.locked_main())"
            )
            result = subprocess.run([sys.executable, "-c", code], cwd=Path(__file__).parent, text=True, capture_output=True)
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
        self.assertEqual(75, result.returncode)
        self.assertEqual("LOCK_BUSY", json.loads(audit.read_text(encoding="utf-8").splitlines()[0])["event"])

    def test_fresh_snapshot_is_accepted_and_stale_rejected(self):
        now = dt.datetime(2026, 9, 8, 0, 30, tzinfo=dt.timezone.utc)
        data = {"summary": {"generatedAt": "2026-09-08T00:00:00Z", "targetSync": {"ok": True}, "safety": {"dataFreshness": {"readyForProduction": True}}}}
        auto.validate_snapshot(data, now)
        with self.assertRaisesRegex(RuntimeError, "snapshot is stale"):
            auto.validate_snapshot(data, now + dt.timedelta(hours=3))
        with self.assertRaisesRegex(RuntimeError, "target sync is not verified"):
            auto.validate_snapshot({"summary": {**data["summary"], "targetSync": {"ok": False}}}, now)
        naive = {"summary": {**data["summary"], "generatedAt": "2026-09-08T00:00:00"}}
        with self.assertRaisesRegex(RuntimeError, "explicit timezone"):
            auto.validate_snapshot(naive, now)

    def test_authenticated_target_sync_rejects_redirects_and_final_url_mismatch(self):
        self.assertIsNone(auto.NoRedirectHandler().redirect_request(None, None, 302, "Found", {}, "https://attacker.invalid"))
        class Response:
            closed = False
            def geturl(self): return "https://attacker.invalid"
            def close(self): self.closed = True
        response = Response()
        opener = type("Opener", (), {"open": lambda self, request, timeout: response})()
        with patch.object(auto.urllib.request, "build_opener", return_value=opener):
            with self.assertRaisesRegex(RuntimeError, "final URL mismatch"):
                auto.open_exact_url(auto.urllib.request.Request(auto.DEFAULT_TARGETS_URL), auto.DEFAULT_TARGETS_URL, 1)
        self.assertTrue(response.closed)

    def test_invalid_wal_state_fails_closed_and_prepared_requires_manual_resolution(self):
        self.wal.write_text(json.dumps({"version": 1, "entries": [{"operationId": "bad", "state": "TYPO"}]}), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "WAL entry is invalid"):
            auto.unresolved_wal_entries(self.wal)
        auto.fsync_json(self.wal, {"version": 1, "entries": [{"operationId": "safe", "state": "PREPARED"}]})
        self.assertEqual(1, len(auto.unresolved_wal_entries(self.wal)))
        auto.transition_wal("safe", "FAILED", path=self.wal)
        with self.assertRaisesRegex(RuntimeError, "illegal auto-apply WAL transition"):
            auto.transition_wal("safe", "SUBMITTING", path=self.wal)


if __name__ == "__main__":
    unittest.main()
