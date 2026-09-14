import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeRppDashboardSnapshot } from "./rppDashboardSnapshots.ts";

const snapshotSource = readFileSync(new URL("./rppDashboardSnapshots.ts", import.meta.url), "utf8");
const receiptKey = "test-only-rpp-performance-receipt-key-123456";
process.env.RPP_PERFORMANCE_RECEIPT_HMAC_KEY = receiptKey;
function signedReceipt(date: string, count: number) {
  const receipt = { version: 1 as const, file: "receipt.json", completedAt: "2026-08-31T05:01:00Z", sha256: "a".repeat(64), actualCount: count, requestStartedAt: "2026-08-31T13:59:00+09:00", historyCreatedAt: "2026-08-31 14:00:00", historyRowSha256: "b".repeat(64), sourceArchiveSha256: "c".repeat(64), complete: true as const };
  const message = [receipt.version, receipt.sha256, date, date, receipt.actualCount, receipt.requestStartedAt, receipt.historyCreatedAt, receipt.historyRowSha256, receipt.sourceArchiveSha256].join("\n");
  return { ...receipt, signature: createHmac("sha256", receiptKey).update(message).digest("hex") };
}

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
  const snapshot = normalizeRppDashboardSnapshot({ schemaVersion: 2, syncedAt: "2026-08-31T06:00:00Z", recommendations: { summary: {}, recommendations: [] }, latestFiles: [], performanceDaily: { source: "rpp_item_reports.csv", sourceMtime: "2026-08-31T05:00:00Z", date: "2026-08-30", attribution: { sales12h: true, sales720h: true }, rows: [{ itemCode: "R0579", ctr: 1.2, clicks: 10, spend: 300, sales12h: 500, orders12h: 1, sales720h: 700, orders720h: 2 }], receipt: signedReceipt("2026-08-30", 1) } });
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.performanceDaily?.rows[0].itemCode, "r0579");
  assert.equal(snapshot.performanceDaily?.rows[0].sales720h, 700);
});

test("RPP dashboard snapshot rejects a forged performance receipt", () => {
  const receipt = { ...signedReceipt("2026-08-30", 1), signature: "0".repeat(64) };
  assert.throws(() => normalizeRppDashboardSnapshot({ schemaVersion: 2, syncedAt: "2026-08-31T06:00:00Z", recommendations: { summary: {}, recommendations: [] }, latestFiles: [], performanceDaily: { source: "rpp_item_reports.csv", sourceMtime: "2026-08-31T05:00:00Z", date: "2026-08-30", attribution: { sales12h: true, sales720h: true }, rows: [{ itemCode: "R0579", ctr: 1.2, clicks: 10, spend: 300, sales12h: 500, orders12h: 1, sales720h: 700, orders720h: 2 }], receipt } }), /verified receipt is invalid/);
});

test("古い実績は新しいobservedAtだけで上書きしない", () => {
  assert.match(snapshotSource, /where excluded\.source_mtime > \$\{PERFORMANCE_TABLE\}\.source_mtime/);
  assert.doesNotMatch(snapshotSource, /source_mtime[^`]+or excluded\.observed_at/i);
  assert.match(snapshotSource, /performance daily source is older than persisted data/);
  assert.match(snapshotSource, /pg_advisory_xact_lock\(hashtext\(\$1\)\).*rpp-performance-global/s);
  assert.match(snapshotSource, /performance daily date is older than latest persisted date/);
  assert.ok(snapshotSource.indexOf("assertPersistedPerformanceMatches") < snapshotSource.lastIndexOf(`insert into \${TABLE}`));
});

test("実績payloadは検証済みdownload receiptを必須とする", () => {
  const base = { schemaVersion: 2, syncedAt: "2026-08-31T06:00:00Z", recommendations: { summary: {}, recommendations: [] }, latestFiles: [], performanceDaily: { source: "rpp_item_reports.csv", sourceMtime: "2026-08-31T05:00:00Z", date: "2026-08-30", attribution: { sales12h: true, sales720h: true }, rows: [] } };
  assert.throws(() => normalizeRppDashboardSnapshot(base), /verified receipt/);
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

test("除外中を含む全設定行をON復帰判定用にRender保存する", () => {
  const snapshot = normalizeRppDashboardSnapshot({
    syncedAt: "2026-09-11T03:00:00Z",
    recommendations: { summary: {}, recommendations: [] },
    latestFiles: [],
    rppData: {
      configuredTargets: [],
      allConfiguredTargets: [
        { id: "r0406__item", itemCode: "r0406", itemName: "ゴミ箱", keyword: "商品CPC", itemCpc: 30, keywordCpc: null, source: "商品CPC", owner: "森下" },
        { id: "r0406__kw", itemCode: "r0406", itemName: "ゴミ箱", keyword: "ゴミ カラスよけ", itemCpc: 30, keywordCpc: 40, source: "キーワードCPC", owner: "森下" },
      ],
      exclusionProducts: [{ itemCode: "r0406", itemName: "ゴミ箱", itemCpc: 30, excluded: true, owner: "森下" }],
      exclusionObservation: { observedAt: "2026-09-11T02:59:00Z", expectedCount: 767, actualCount: 767, complete: true },
      owners: ["森下"],
    },
  });
  assert.equal(snapshot.schemaVersion, 4);
  assert.equal(snapshot.rppData?.configuredTargets.length, 0);
  assert.deepEqual((snapshot.rppData?.allConfiguredTargets ?? []).map((row) => row.id), ["r0406__item", "r0406__kw"]);
  assert.deepEqual(snapshot.rppData?.exclusionObservation, { observedAt: "2026-09-11T02:59:00.000Z", expectedCount: 767, actualCount: 767, complete: true });
});

test("RMS除外観測は表示件数と収集件数が不一致ならcompleteにならない", () => {
  const snapshot = normalizeRppDashboardSnapshot({
    syncedAt: "2026-09-11T03:00:00Z", recommendations: { summary: {}, recommendations: [] }, latestFiles: [],
    rppData: { configuredTargets: [], exclusionProducts: [], owners: [],
      exclusionObservation: { observedAt: "2026-09-11T02:59:00Z", expectedCount: 10, actualCount: 9, complete: true } },
  });
  assert.equal(snapshot.rppData?.exclusionObservation?.complete, false);
});
