import assert from "node:assert/strict";
import test from "node:test";
import { buildRppCurrentMonthKpis, buildRppDashboardChartSeries, buildRppDashboardPeriodSeries, buildRppDeliveryComposition, chartPolyline, type RppDashboardDailyMetric } from "./rppDashboardCharts.ts";

const day = (delta: number) => {
  const value = new Date(Date.now() + 9 * 60 * 60_000 + delta * 86_400_000);
  return value.toISOString().slice(0, 10);
};

test("ダッシュボード推移は日付順・実データROASで生成する", () => {
  const rows = buildRppDashboardChartSeries([
    { date: "2026-09-14", spend: 1000, sales: 3000, clicks: 10 },
    { date: "2026-09-13", spend: 2000, sales: 1000, clicks: 20 },
  ]);
  assert.deepEqual(rows.map((row) => row.date), ["2026-09-13", "2026-09-14"]);
  assert.deepEqual(rows.map((row) => Math.round(row.roas ?? 0)), [50, 300]);
  assert.deepEqual(rows.map((row) => row.label), ["9/13", "9/14"]);
});

test("広告費0日はROASを未取得にし、不正な負数を表示しない", () => {
  const [row] = buildRppDashboardChartSeries([{ date: "2026-09-14", spend: 0, sales: -100, clicks: -2 }]);
  assert.equal(row.roas, null);
  assert.equal(row.sales, 0);
  assert.equal(row.clicks, 0);
});

test("同一maximumを渡した系列は同じ金額スケールを使う", () => {
  const low = chartPolyline([100], 560, 180, 22, 1000);
  const high = chartPolyline([1000], 560, 180, 22, 1000);
  assert.notEqual(low, high);
  assert.match(high[0], /22\.0,22\.0/);
});

test("ROAS欠損日は前後を補間せず線を分割する", () => {
  const segments = chartPolyline([100, null, 200]);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].split(" ").length, 1);
  assert.equal(segments[1].split(" ").length, 1);
});

test("実績がない暦日をnullで補い、線を接続しない", () => {
  const rows = buildRppDashboardChartSeries([
    { date: "2026-09-11", spend: 100, sales: 200, clicks: 1 },
    { date: "2026-09-13", spend: 300, sales: 600, clicks: 2 },
  ]);
  assert.deepEqual(rows.map((row) => row.date), ["2026-09-11", "2026-09-12", "2026-09-13"]);
  assert.equal(rows[1].spend, null);
  assert.equal(chartPolyline(rows.map((row) => row.spend)).length, 2);
});

test("JSTの14暦日窓は先頭・末尾・全欠損と1観測日を保持し未来日を除外する", () => {
  const input: RppDashboardDailyMetric[] = Array.from({ length: 14 }, (_, index) => ({ date: day(index - 13), spend: null, sales: null, clicks: null }));
  input[6] = { date: day(-7), spend: 100, sales: 200, clicks: 1 };
  const rows = buildRppDashboardChartSeries([...input, { date: day(1), spend: 999, sales: 999, clicks: 9 }]);
  assert.equal(rows.length, 14);
  assert.equal(rows[0].spend, null);
  assert.equal(rows.at(-1)?.spend, null);
  assert.equal(rows.filter((row) => row.spend != null).length, 1);
  assert.equal(buildRppDashboardChartSeries(input.map((row) => ({ ...row, spend: null, sales: null, clicks: null }))).length, 14);
  assert.equal(rows.some((row) => row.date === day(1)), false);
});

const deliverySnapshot = (input: {
  syncedAt?: string;
  allConfiguredTargets?: Array<{ itemCode: string }>;
  exclusionProducts?: Array<{ itemCode: string; excluded: boolean }>;
  observation?: { observedAt: string; complete: boolean };
}) => ({
  syncedAt: input.syncedAt,
  rppData: {
    allConfiguredTargets: input.allConfiguredTargets,
    exclusionProducts: input.exclusionProducts ?? [],
    exclusionObservation: input.observation,
  },
});

test("全RPP母集団が欠落した旧snapshotは0商品でなく未取得にする", () => {
  const result = buildRppDeliveryComposition(deliverySnapshot({}), new Date("2026-09-15T09:00:00Z"));
  assert.deepEqual(result, { state: "UNAVAILABLE", total: 0, active: 0, excluded: 0, unknown: 0 });
  const empty = buildRppDeliveryComposition(deliverySnapshot({
    syncedAt: "2026-09-15T08:30:00Z",
    allConfiguredTargets: [],
    observation: { observedAt: "2026-09-15T08:40:00Z", complete: true },
  }), new Date("2026-09-15T09:00:00Z"));
  assert.deepEqual(empty, { state: "UNAVAILABLE", total: 0, active: 0, excluded: 0, unknown: 0 });
});

test("不完全・期限切れ・未来の観測は全RPP商品を未確認にする", () => {
  const base = { syncedAt: "2026-09-15T08:30:00Z", allConfiguredTargets: [{ itemCode: "A" }, { itemCode: "a" }, { itemCode: "B" }], exclusionProducts: [{ itemCode: "a", excluded: false }, { itemCode: "b", excluded: true }] };
  for (const observation of [
    { observedAt: "2026-09-15T08:40:00Z", complete: false },
    { observedAt: "2026-09-15T06:59:59Z", complete: true },
    { observedAt: "2026-09-15T09:00:01Z", complete: true },
  ]) {
    assert.deepEqual(buildRppDeliveryComposition(deliverySnapshot({ ...base, observation }), new Date("2026-09-15T09:00:00Z")), { state: "UNKNOWN", total: 2, active: 0, excluded: 0, unknown: 2 });
  }
});

test("同一fresh complete snapshotだけで全RPP商品を重複なく配信分類する", () => {
  const result = buildRppDeliveryComposition(deliverySnapshot({
    syncedAt: "2026-09-15T08:30:00Z",
    allConfiguredTargets: [{ itemCode: "A" }, { itemCode: "a" }, { itemCode: "B" }, { itemCode: "C" }],
    exclusionProducts: [{ itemCode: "a", excluded: false }, { itemCode: "b", excluded: true }],
    observation: { observedAt: "2026-09-15T08:40:00Z", complete: true },
  }), new Date("2026-09-15T09:00:00Z"));
  assert.deepEqual(result, { state: "CURRENT", total: 3, active: 1, excluded: 1, unknown: 1 });
});

test("日次・週次・月次はJST固定窓で実績だけを集計する", () => {
  const metrics: RppDashboardDailyMetric[] = [
    { date: "2026-08-31", spend: 100, sales: 200, clicks: 10, orders: 1 },
    { date: "2026-09-01", spend: 300, sales: 900, clicks: 30, orders: 6 },
    { date: "2026-09-14", spend: 200, sales: 400, clicks: 20, orders: 2 },
    { date: "2026-09-16", spend: 999, sales: 999, clicks: 999, orders: 999 },
  ];
  const now = new Date("2026-09-15T09:00:00Z");
  const daily = buildRppDashboardPeriodSeries(metrics, "DAY", now);
  const weekly = buildRppDashboardPeriodSeries(metrics, "WEEK", now);
  const monthly = buildRppDashboardPeriodSeries(metrics, "MONTH", now);
  assert.equal(daily.length, 14);
  assert.equal(weekly.length, 12);
  assert.equal(monthly.length, 12);
  assert.deepEqual(daily.at(-2), { date: "2026-09-14", label: "9/14", spend: 200, sales: 400, clicks: 20, orders: 2, roas: 200, cvr: 10 });
  assert.equal(weekly.at(-1)?.spend, 200);
  assert.equal(monthly.at(-1)?.spend, 500);
  assert.equal(monthly.at(-1)?.orders, 8);
});

test("当月クリックと720時間CV・CVRは欠損を0にせず集計する", () => {
  const now = new Date("2026-09-15T09:00:00Z");
  assert.deepEqual(buildRppCurrentMonthKpis([
    { date: "2026-09-01", spend: 1, sales: 1, clicks: 80, orders: 8 },
    { date: "2026-09-14", spend: 1, sales: 1, clicks: 20, orders: 2 },
    { date: "2026-08-31", spend: 1, sales: 1, clicks: 999, orders: 999 },
  ], now), { clicks: 100, orders: 10, cvr: 10 });
  assert.deepEqual(buildRppCurrentMonthKpis([], now), { clicks: null, orders: null, cvr: null });
});
