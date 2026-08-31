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

test("RPP dashboard snapshot rejects missing recommendation rows", () => {
  assert.throws(() => normalizeRppDashboardSnapshot({ recommendations: {}, latestFiles: [] }), /must be an array/);
});
