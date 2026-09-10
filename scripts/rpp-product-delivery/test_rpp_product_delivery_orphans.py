import datetime as dt
import unittest
from pathlib import Path

import rpp_product_delivery_scheduler as scheduler


class OrphanSafetyTest(unittest.TestCase):
    def test_owned_orphan_on_restores(self):
        at = dt.datetime(2026, 9, 10, 1, tzinfo=dt.timezone.utc)
        reservation = {"id": "orphan-on", "itemCode": "item-a", "action": "ON", "executeAt": at, "orphaned": True}
        state = scheduler.default_state()
        state["owned"] = ["item-a"]
        state["reservationOff"] = ["item-a"]
        state, changes, failures, completed = scheduler.process_due_reservations(
            state, [reservation], at, set(), {"item-a"}, {"item-a"}, False,
            "https://example.invalid", Path("/tmp/state"), Path("/tmp/wal"), Path("/tmp/audit"),
        )
        self.assertEqual([row["action"] for row in changes], ["ON"])
        self.assertEqual(completed, ["orphan-on"])
        self.assertEqual(failures, [])
        self.assertEqual(state["owned"], [])
        self.assertEqual(state["reservationOff"], [])

    def test_preexisting_orphan_is_not_released(self):
        at = dt.datetime(2026, 9, 10, 1, tzinfo=dt.timezone.utc)
        reservation = {"id": "orphan-on", "itemCode": "item-a", "action": "ON", "executeAt": at, "orphaned": True}
        _, changes, failures, completed = scheduler.process_due_reservations(
            scheduler.default_state(), [reservation], at, set(), {"item-a"}, {"item-a"}, False,
            "https://example.invalid", Path("/tmp/state"), Path("/tmp/wal"), Path("/tmp/audit"),
        )
        self.assertEqual(changes, [])
        self.assertEqual(completed, [])
        self.assertIn("ワーカー所有", failures[0]["error"])


if __name__ == "__main__":
    unittest.main()
