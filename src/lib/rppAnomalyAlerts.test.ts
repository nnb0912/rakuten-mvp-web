import assert from "node:assert/strict";
import test from "node:test";
import { detectRppAnomalies, evaluateChatworkDelivery, formatRppAnomalyMessage } from "./rppAnomalyAlerts.ts";
import { aggregateRppAnomalySnapshot } from "./rppAnomalyData.ts";

test("実績行を広告費加重CPC・全体ROASへ集計する", () => {
  const snapshot = aggregateRppAnomalySnapshot({
    summary: { generatedAt: "2026-09-01T00:00:00.000Z" },
    recommendations: [
      { spend: 1_000, salesAmount: 10_000, clicks: 20, currentCpc: 50 },
      { spend: 3_000, salesAmount: 15_000, clicks: 30, currentCpc: 100 },
    ],
  });
  assert.equal(snapshot.cpc, 80);
  assert.equal(snapshot.roas, 625);
  assert.equal(snapshot.spend, 4_000);
  assert.equal(snapshot.rowCount, 2);
  assert.equal(snapshot.requiredFieldsPresent, true);
});

test("CPC急騰・ROAS急落・費用急増・欠損・鮮度・件数差を検知する", () => {
  const anomalies = detectRppAnomalies({
    current: { cpc: 150, roas: 400, spend: 30_000, observedAt: "2026-08-29T00:00:00.000Z", rowCount: 8, requiredFieldsPresent: false },
    previous: { cpc: 100, roas: 1000, spend: 10_000, rowCount: 10 },
    now: "2026-09-01T00:00:00.000Z",
    thresholds: { cpcRiseRate: 0.4, roasDropRate: 0.4, spendRiseRate: 1, staleHours: 36 },
  });
  assert.deepEqual(anomalies.map((row) => row.type), ["CPC_SPIKE", "ROAS_DROP", "SPEND_SPIKE", "DATA_MISSING", "DATA_STALE", "COUNT_MISMATCH"]);
});

test("閾値未満かつ新鮮なデータはアラートなし", () => {
  const anomalies = detectRppAnomalies({
    current: { cpc: 105, roas: 950, spend: 11_000, observedAt: "2026-09-01T00:00:00.000Z", rowCount: 10, requiredFieldsPresent: true },
    previous: { cpc: 100, roas: 1000, spend: 10_000, rowCount: 10 },
    now: "2026-09-01T01:00:00.000Z",
  });
  assert.deepEqual(anomalies, []);
});

test("Chatworkは既定Dry Runで、明示ゲートと設定が揃う場合だけ送信可能", () => {
  assert.deepEqual(evaluateChatworkDelivery({ requestedSend: false, sendEnabled: false, tokenPresent: false, roomPresent: false }), { mode: "DRY_RUN", canSend: false, reason: "Dry Run（既定）" });
  assert.equal(evaluateChatworkDelivery({ requestedSend: true, sendEnabled: false, tokenPresent: true, roomPresent: true }).mode, "BLOCKED");
  assert.equal(evaluateChatworkDelivery({ requestedSend: true, sendEnabled: true, tokenPresent: false, roomPresent: true }).mode, "BLOCKED");
  assert.equal(evaluateChatworkDelivery({ requestedSend: true, sendEnabled: true, tokenPresent: true, roomPresent: true }).mode, "SEND");
});

test("通知本文は件数・種別・RMS変更なしを含み、認証情報を含めない", () => {
  const message = formatRppAnomalyMessage([{ type: "CPC_SPIKE", severity: "WARNING", label: "CPC急騰", detail: "100円→150円" }], "2026-09-01T00:00:00.000Z");
  assert.match(message, /RPP異常検知 1件/);
  assert.match(message, /CPC急騰/);
  assert.match(message, /RMS変更: なし/);
  assert.doesNotMatch(message, /token|room/i);
});
