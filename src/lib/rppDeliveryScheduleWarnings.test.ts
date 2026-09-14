import assert from "node:assert/strict";
import test from "node:test";

import {
  assessRppDeliveryReservation,
  isInsideRppRecurringWindow,
  rppDeliveryReservationWarnings,
  rppDeliveryScheduleWarnings,
  rppDeliveryWarningKeysMatch,
} from "./rppDeliveryScheduleWarnings.ts";

const overnight = { enabled: true, startTime: "23:00", endTime: "07:00" };

test("JSTの日跨ぎ毎日停止時間を判定する", () => {
  assert.equal(isInsideRppRecurringWindow(overnight, "2026-09-14T15:30:00.000Z"), true);
  assert.equal(isInsideRppRecurringWindow(overnight, "2026-09-14T03:00:00.000Z"), false);
  assert.equal(isInsideRppRecurringWindow(overnight, "2026-09-14T22:00:00.000Z"), false);
});

test("毎日停止と単発予約の影響を動作別に警告する", () => {
  assert.match(rppDeliveryReservationWarnings(overnight, { action: "ON", executeAt: "2026-09-14T15:30:00.000Z" })[0], /停止を上書き/);
  assert.match(rppDeliveryReservationWarnings(overnight, { action: "OFF", executeAt: "2026-09-14T15:30:00.000Z" })[0], /重複/);
  assert.match(rppDeliveryReservationWarnings(overnight, { action: "OFF", executeAt: "2026-09-14T03:00:00.000Z" })[0], /ON予約が必要/);
  assert.match(rppDeliveryReservationWarnings(overnight, { action: "ON", executeAt: "2026-09-14T03:00:00.000Z" })[0], /次の毎日停止/);
});

test("毎日停止の切替時刻と正反対の予約を拒否する", () => {
  const startOn = assessRppDeliveryReservation(overnight, { action: "ON", executeAt: "2026-09-14T14:00:00.000Z" });
  const endOff = assessRppDeliveryReservation(overnight, { action: "OFF", executeAt: "2026-09-14T22:00:00.000Z" });
  assert.match(startOn.blocked?.message ?? "", /正反対/);
  assert.match(endOff.blocked?.message ?? "", /正反対/);
  assert.equal(startOn.warnings.length, 0);
  assert.equal(endOff.warnings.length, 0);
});

test("保留・実行中だけを警告対象にし重複文言をまとめる", () => {
  const warnings = rppDeliveryScheduleWarnings(overnight, [
    { action: "ON", executeAt: "2026-09-14T15:30:00.000Z", status: "PENDING" },
    { action: "ON", executeAt: "2026-09-15T15:30:00.000Z", status: "RUNNING" },
    { action: "OFF", executeAt: "2026-09-14T15:30:00.000Z", status: "CANCELLED" },
  ]);
  assert.equal(warnings.length, 1);
});

test("警告承認キーは現在集合と完全一致する場合だけ有効", () => {
  const warnings = [{ key: "CUSTOM:INSIDE:ON", message: "確認" }];
  assert.equal(rppDeliveryWarningKeysMatch(warnings, ["CUSTOM:INSIDE:ON"]), true);
  assert.equal(rppDeliveryWarningKeysMatch(warnings, []), false);
  assert.equal(rppDeliveryWarningKeysMatch(warnings, ["CUSTOM:INSIDE:ON", "LEGACY:OUTSIDE:ON"]), false);
});
