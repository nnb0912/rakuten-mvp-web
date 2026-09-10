import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectDir = await mkdtemp(path.join(os.tmpdir(), "rpp-delivery-schedules-"));
process.env.RPP_PROJECT_DIR = projectDir;
const {
  cancelRppDeliveryReservation,
  claimRppDeliveryReservation,
  createRppDeliveryReservation,
  heartbeatRppDeliveryReservation,
  jstLocalDateTimeToIso,
  markRppDeliveryReservation,
  readRppDeliverySchedules,
  releaseRppDeliveryReservationClaim,
  summarizeRppDeliverySchedule,
  withRppDeliveryReservationRuntimeStatus,
  writeRppRecurringSchedule,
} = await import("./rppDeliverySchedules.ts");

test.after(async () => {
  delete process.env.RPP_PROJECT_DIR;
  await rm(projectDir, { recursive: true, force: true });
});

test("商品別の毎日停止時間を保存し、日跨ぎ時間帯を維持する", async () => {
  const saved = await writeRppRecurringSchedule(" Item-A ", {
    enabled: true,
    startTime: "22:30",
    endTime: "06:15",
  });
  assert.equal(saved.schedules.length, 1);
  assert.equal(saved.schedules[0]?.itemCode, "item-a");
  assert.deepEqual(saved.schedules[0]?.recurring, { enabled: true, startTime: "22:30", endTime: "06:15" });
  assert.ok(saved.schedules[0]?.updatedAt);

  await writeRppRecurringSchedule("ITEM-B", { enabled: false, startTime: "01:00", endTime: "05:00" });
  const readback = await readRppDeliverySchedules();
  assert.equal(readback.schedules.length, 2);
  const persisted = JSON.parse(await readFile(path.join(projectDir, "rpp_targets", "rpp_delivery_schedules.json"), "utf8"));
  assert.equal(persisted.schedules.length, 2);
});

test("毎日停止は更新時刻で競合を防ぎ、変更者を保持する", async () => {
  const before = (await readRppDeliverySchedules({ itemCode: "item-a" })).schedules[0]!;
  const updated = await writeRppRecurringSchedule(
    "item-a",
    { enabled: true, startTime: "23:00", endTime: "07:00" },
    before.updatedAt,
    { email: "operator@example.com", name: "担当者" },
  );
  assert.equal(updated.schedules[0]?.updatedByName, "担当者");
  await assert.rejects(
    () => writeRppRecurringSchedule("item-a", { enabled: false, startTime: "23:00", endTime: "07:00" }, "1970-01-01T00:00:00.000Z"),
    /更新されました/,
  );
});

test("毎日停止時間はHH:mm、異なる開始終了、booleanを必須にする", async () => {
  await assert.rejects(() => writeRppRecurringSchedule("item-a", { enabled: true, startTime: "9:00", endTime: "10:00" }), /HH:mm/);
  await assert.rejects(() => writeRppRecurringSchedule("item-a", { enabled: true, startTime: "09:00", endTime: "09:00" }), /異なる時刻/);
  await assert.rejects(() => writeRppRecurringSchedule("item-a", { enabled: "true" as unknown as boolean, startTime: "09:00", endTime: "10:00" }), /boolean/);
});

test("datetime-localをJSTとしてISO化し、未来のON/OFF予約を作成する", async () => {
  assert.equal(jstLocalDateTimeToIso("2030-01-02T03:04", "Asia/Tokyo"), "2030-01-01T18:04:00.000Z");
  assert.throws(() => jstLocalDateTimeToIso("2030-01-02T03:04", "UTC"), /Asia\/Tokyo/);
  const now = new Date("2030-01-01T00:00:00.000Z");
  const created = await createRppDeliveryReservation("ITEM-A", "OFF", "2030-01-02T03:04", "Asia/Tokyo", now);
  assert.equal(created.reservation.itemCode, "item-a");
  assert.equal(created.reservation.action, "OFF");
  assert.equal(created.reservation.executeAt, "2030-01-01T18:04:00.000Z");
  assert.equal(created.reservation.status, "PENDING");
  await assert.rejects(() => createRppDeliveryReservation("item-a", "PAUSE" as "ON", "2030-01-02T03:04", "Asia/Tokyo", now), /ONまたはOFF/);
  await assert.rejects(() => createRppDeliveryReservation("item-a", "ON", "2029-01-02T03:04", "Asia/Tokyo", now), /未来/);
});

test("claim・heartbeat・実行中表示・取消防止・終端ACKを検証する", async () => {
  const now = new Date("2031-01-01T00:00:00.000Z");
  const first = (await createRppDeliveryReservation("item-c", "ON", "2031-01-02T12:00", "Asia/Tokyo", now)).reservation;
  const cancelled = await cancelRppDeliveryReservation(first.id, "item-c");
  assert.equal(cancelled.reservation.status, "CANCELLED");

  const second = (await createRppDeliveryReservation("item-c", "OFF", "2031-01-03T12:00", "Asia/Tokyo", now)).reservation;
  const claimed = await claimRppDeliveryReservation(second.id, new Date("2031-01-04T00:00:00.000Z"));
  const claimId = claimed.reservation.claimId!;
  assert.equal(withRppDeliveryReservationRuntimeStatus(claimed.reservation, new Date("2031-01-04T00:01:00.000Z")).status, "RUNNING");
  await assert.rejects(() => cancelRppDeliveryReservation(second.id, "item-c"), /実行処理中/);
  const heartbeat = await heartbeatRppDeliveryReservation(second.id, claimId, new Date("2031-01-04T00:01:00.000Z"));
  assert.ok(Date.parse(heartbeat.reservation.claimExpiresAt!) > Date.parse(claimed.reservation.claimExpiresAt!));
  const failed = await markRppDeliveryReservation(second.id, claimId, "FAILED", "RMS readback mismatch");
  assert.equal(failed.reservation.status, "FAILED");
  const retry = await markRppDeliveryReservation(second.id, claimId, "FAILED", "RMS readback mismatch");
  assert.equal(retry.reservation.status, "FAILED");
  await assert.rejects(() => markRppDeliveryReservation(second.id, claimId, "SUCCEEDED"), /claim/);

  const third = (await createRppDeliveryReservation("item-c", "OFF", "2031-01-04T12:00", "Asia/Tokyo", now)).reservation;
  const thirdClaim = await claimRppDeliveryReservation(third.id, new Date("2031-01-05T00:00:00.000Z"));
  const released = await releaseRppDeliveryReservationClaim(third.id, thirdClaim.reservation.claimId, "temporary login failure");
  assert.equal(released.reservation.status, "PENDING");
  assert.equal(released.reservation.claimId, null);
});

test("同一商品・同一日時の予約は冪等で、反対動作との競合を拒否する", async () => {
  const now = new Date("2032-01-01T00:00:00.000Z");
  const first = await createRppDeliveryReservation("item-d", "OFF", "2032-01-02T12:00", "Asia/Tokyo", now);
  const retry = await createRppDeliveryReservation("item-d", "OFF", "2032-01-02T12:00", "Asia/Tokyo", now);
  assert.equal(retry.reservation.id, first.reservation.id);
  await assert.rejects(() => createRppDeliveryReservation("item-d", "ON", "2032-01-02T12:00", "Asia/Tokyo", now), /同時登録/);
});

test("実効状態・次回切替・待ち件数を要約する", async () => {
  const data = await readRppDeliverySchedules({ itemCode: "item-a" });
  const status = summarizeRppDeliverySchedule(data.schedules[0], data.reservations, new Date("2030-01-01T14:30:00.000Z"));
  assert.equal(status.itemCode, "item-a");
  assert.equal(status.recurringActive, true);
  assert.equal(status.effectiveState, "OFF");
  assert.equal(status.nextTransition?.action, "OFF");
});
