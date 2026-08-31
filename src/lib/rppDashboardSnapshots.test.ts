import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRppDashboardSnapshot } from "./rppDashboardSnapshots.ts";

test("RPP dashboard snapshot payload is normalized", () => {
  const snapshot = normalizeRppDashboardSnapshot({
    syncedAt: "2026-08-31T06:00:00+00:00",
    recommendations: { summary: { counts: { raise: 1 } }, recommendations: [{ itemCode: "r0001" }] },
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
  assert.throws(() => normalizeRppDashboardSnapshot({ recommendations: {}, latestFiles: [] }), /must be an array/);
});
