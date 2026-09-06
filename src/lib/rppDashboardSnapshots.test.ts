import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRppDashboardSnapshot } from "./rppDashboardSnapshots.ts";

test("RPP dashboard snapshot payload is normalized", () => {
  const snapshot = normalizeRppDashboardSnapshot({
    syncedAt: "2026-08-31T06:00:00+00:00",
    recommendations: { summary: { counts: { hold: 1 } }, recommendations: [{ itemCode: "r0001", keyword: "商品CPC", action: "HOLD", currentCpc: null, proposedCpc: null, source: null, reasons: [], blocks: ["データ不足"], uploadReady: false }] },
    latestFiles: [{ name: "rpp_keyword_reports.csv", exists: true, mtime: "2026-08-31T05:00:00Z", size: "123" }],
    cronStatus: { ok: true },
  });
  assert.equal(snapshot.syncedAt, "2026-08-31T06:00:00.000Z");
  assert.equal(snapshot.recommendations.recommendations.length, 1);
  assert.equal(snapshot.latestFiles[0].size, 123);
});

test("RPP dashboard snapshot accepts validated single-day performance rows", () => {
  const snapshot = normalizeRppDashboardSnapshot({ schemaVersion: 2, syncedAt: "2026-08-31T06:00:00Z", recommendations: { summary: {}, recommendations: [] }, latestFiles: [], performanceDaily: { source: "rpp_item_reports.csv", sourceMtime: "2026-08-31T05:00:00Z", date: "2026-08-30", attribution: { sales12h: true, sales720h: true }, rows: [{ itemCode: "R0579", ctr: 1.2, clicks: 10, spend: 300, sales12h: 500, orders12h: 1, sales720h: 700, orders720h: 2 }] } });
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.performanceDaily?.rows[0].itemCode, "r0579");
  assert.equal(snapshot.performanceDaily?.rows[0].sales720h, 700);
});

test("RPP dashboard snapshot rejects missing recommendation rows", () => {
  assert.throws(() => normalizeRppDashboardSnapshot({ syncedAt: "2026-09-06T12:00:00Z", recommendations: {}, latestFiles: [] }), /must be an array/);
});

test("変更候補の必須CPC・安全フィールドと同期時刻を検証する", () => {
  const base = { syncedAt: "2026-09-06T12:00:00Z", latestFiles: [], recommendations: { summary: {}, recommendations: [] } };
  assert.throws(() => normalizeRppDashboardSnapshot({ ...base, syncedAt: "invalid" }), /syncedAt/);
  assert.throws(() => normalizeRppDashboardSnapshot({ ...base, recommendations: { summary: {}, recommendations: [{ itemCode: "r0445", keyword: "商品CPC", action: "RAISE", currentCpc: null, proposedCpc: 30, source: null, reasons: [], blocks: [], uploadReady: true }] } }), /actionable CPC fields/);
  assert.throws(() => normalizeRppDashboardSnapshot({ ...base, recommendations: { summary: {}, recommendations: [{ itemCode: "r0445", keyword: "商品CPC", action: "UNKNOWN", reasons: [], blocks: [], uploadReady: false }] } }), /action is invalid/);
});

test("configuredTargetsの基準ワード別順位をRender保存時に保持する", () => {
  const snapshot = normalizeRppDashboardSnapshot({
    syncedAt: "2026-09-06T12:00:00Z",
    recommendations: { summary: {}, recommendations: [] },
    latestFiles: [],
    rppData: {
      configuredTargets: [{
        id: "r0445__item", itemCode: "r0445", itemName: "時計", keyword: "商品CPC",
        itemCpc: 20, keywordCpc: null, source: "商品CPC", owner: "森下",
        rppPosition: "PC 3位 / SP 2位", rppPositionKeyword: "壁掛け時計",
        rppPositions: [{ keyword: "壁掛け時計", position: "PC 3位 / SP 2位" }],
      }],
      exclusionProducts: [],
      owners: ["森下"],
    },
  });
  const row = snapshot.rppData?.configuredTargets[0];
  assert.equal(row?.rppPosition, "PC 3位 / SP 2位");
  assert.equal(row?.rppPositionKeyword, "壁掛け時計");
  assert.deepEqual(row?.rppPositions, [{ keyword: "壁掛け時計", position: "PC 3位 / SP 2位" }]);
});
