import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app/rpp/RppBudgetPanel.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../app/rpp/page.tsx", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../app/api/rpp/budget-settings/route.ts", import.meta.url), "utf8");

test("予算管理はRMS有効予算を表示し、当月・翌月予算の入力欄を持たない", () => {
  assert.match(source, /RMS有効予算/);
  assert.match(source, /着地差額/);
  assert.match(source, /予算・実績・着地予測の比較/);
  assert.match(source, /累計計画と累計実績の推移/);
  assert.match(source, /当月実績（取得済み日）/);
  assert.match(source, /永続化済み実績のみ表示/);
  assert.match(source, /current\.at\(-1\)!\.day \+ 1 !== row\.day/);
  assert.match(source, /actualSegments\.map/);
  assert.match(source, /`¥\$\{Math\.round\(value\)/);
  assert.match(source, /当月予算サマリー/);
  assert.match(source, /予算消化率/);
  assert.match(source, /広告経由売上（720時間帰属）/);
  assert.match(source, /actualMonthSpend \/ monthlyBudget \* 100/);
  assert.match(pageSource, /buildRppDashboardPeriodSeries\(dashboardDailyMetrics, "MONTH"\)/);
  assert.doesNotMatch(source, /label="当月予算"/);
  assert.doesNotMatch(source, /label="翌月予算"/);
  assert.match(source, /rmsBudget\.state === "READY"/);
});

test("配分設定APIはlegacy予算列を入力値で上書きしない", () => {
  assert.match(routeSource, /monthlyBudget: current\.settings\.monthlyBudget/);
  assert.match(routeSource, /nextMonthBudget: current\.settings\.nextMonthBudget/);
});
