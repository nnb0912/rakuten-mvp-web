import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("../app/rpp/RppTargetSettings.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/rpp/delivery-schedules/route.ts", import.meta.url), "utf8");
const machineRoute = readFileSync(new URL("../app/api/rpp/sync-snapshot/route.ts", import.meta.url), "utf8");

test("商品CPC行だけに時間指定ボタンと行スコープのパネルを表示する", () => {
  assert.match(component, /productExclusionOperable \? <button className="schedule-button"[\s\S]*?>時間指定<\/button> : null/);
  assert.match(component, /schedulePanelItemCode/);
  assert.match(component, /毎日停止/);
  assert.match(component, /1回限りのON\/OFF予約/);
  assert.match(component, /予約の登録だけではRMSの配信状態は変わりません/);
  assert.match(component, /role="dialog"/);
  assert.match(component, /aria-modal="true"/);
  assert.match(component, /excludedProductToForm/);
  assert.match(component, /openSchedulePanel\(row\.itemCode\)/);
  assert.match(component, /実行中（取消不可）/);
  assert.match(component, /expectedUpdatedAt: scheduleUpdatedAt/);
  assert.match(component, /setInterval\(refreshRuntimeStatus, 15_000\)/);
});

test("UIはJSTのdatetime-localと毎日停止・予約・取消APIを使う", () => {
  assert.match(component, /type="datetime-local"/);
  assert.match(component, /timeZone: "Asia\/Tokyo"/);
  assert.match(component, /fetch\("\/api\/rpp\/delivery-schedules"/);
  assert.match(component, /method: "PATCH"/);
  assert.match(component, /method: "POST"/);
  assert.match(component, /method: "DELETE"/);
});

test("人向けAPIはviewer/operator権限とRPP商品存在確認を行う", () => {
  assert.match(route, /requireRppRole\("viewer"\)/);
  assert.equal((route.match(/requireRppRole\("operator"\)/g) ?? []).length, 3);
  assert.match(route, /readRppProductCpcItemCodes\(\)/);
  assert.match(route, /requireReleaseAllowed/);
  assert.match(route, /全RPP設定行への目標保存/);
});

test("machine APIは指定payloadで保留予約だけを返しackする", () => {
  assert.match(machineRoute, /resource.*delivery-schedules/);
  assert.match(machineRoute, /timeZone: "Asia\/Tokyo"/);
  assert.match(machineRoute, /readPendingRppDeliveryReservations/);
  assert.match(machineRoute, /operation === "CLAIM"/);
  assert.match(machineRoute, /claimRppDeliveryReservation/);
  assert.match(machineRoute, /claimId/);
  assert.match(machineRoute, /operation === "HEARTBEAT"/);
  assert.match(machineRoute, /orphanedSchedules/);
  assert.match(machineRoute, /validItemCodes/);
  assert.match(machineRoute, /readRppProductCpcItemCodes/);
  assert.match(machineRoute, /validItemCodes\.size === 0/);
  assert.match(machineRoute, /delivery scheduling is fail-closed/);
  assert.match(machineRoute, /reservationId/);
  assert.match(machineRoute, /markRppDeliveryReservation/);
});
