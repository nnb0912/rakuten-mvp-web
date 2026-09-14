import assert from "node:assert/strict";
import test from "node:test";
import { buildRppDashboardChartSeries, chartPolyline } from "./rppDashboardCharts.ts";

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
