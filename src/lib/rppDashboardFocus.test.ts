import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.join(process.cwd(), "src/app/rpp/page.tsx"), "utf8");
const chartSource = readFileSync(path.join(process.cwd(), "src/app/rpp/RppDashboardCharts.tsx"), "utf8");
const styles = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

test("ダッシュボードは固定以外の選択モードを主表示する", () => {
  assert.match(source, /自動モードの商品/);
  assert.match(source, /isAutomaticRppOptimizationMode/);
  assert.match(source, /automaticTargets/);
  assert.match(source, /前日広告費/);
  assert.match(source, /前日売上/);
  assert.match(source, /前日ROAS/);
  assert.match(source, /ROAS・検索順位・バランスを選択した設定行/);
  assert.match(source, /automaticTargets\.map/);
  assert.match(source, /target\.keyword/);
  assert.match(source, /商品番号による制限はありません/);
  assert.match(source, /自動モード商品<\/span><strong>\{automaticItemCodes\.size\}/);
  assert.match(source, /excludedAutomaticProducts/);
  assert.doesNotMatch(source, /allowedItemCodes|自動調整を許可した商品|R0445・R0406だけが対象/);
});

test("商品観測がない自動モード商品は広告ONと表示しない", () => {
  assert.match(source, /!row\.product \? "未確認"/);
  assert.match(source, /!row\.product \? \{ label: "未確認"/);
  assert.match(source, /商品状態の実測待ち/);
});

test("売上とROASは720時間帰属を画面とARIAに明記する", () => {
  assert.match(chartSource, /売上（720時間帰属）/);
  assert.match(chartSource, /ROAS推移（720時間帰属）/);
  assert.match(chartSource, /ROAS推移（売上720時間帰属）/);
  assert.doesNotMatch(chartSource, />[^<]*720h[^<]*</);
});

test("全グラフは自動モード以外を含む全RPP母集団を表示する", () => {
  assert.match(source, /readLatestRppDashboardSnapshot\(\)/);
  assert.match(source, /buildRppDeliveryComposition\(latestDashboardSnapshot\)/);
  assert.match(source, /delivery=\{allRppDelivery\}/);
  assert.match(chartSource, /ALL RPP DELIVERY/);
  assert.match(chartSource, /全RPP商品の配信構成/);
  assert.match(chartSource, /全RPP母集団は未取得/);
  assert.match(chartSource, /全RPP商品の母集団を取得できていません/);
  assert.match(chartSource, /delivery\.state === "UNAVAILABLE"/);
  assert.match(chartSource, /配信状態は未確認/);
  assert.doesNotMatch(chartSource, /自動モード商品の配信構成/);
});

test("グラフは日次週次月次を切替え、当月クリックと720時間CV・CVRを表示する", () => {
  assert.match(source, /readRppDashboardDailyMetrics\(366\)/);
  assert.match(chartSource, /useState<RppChartPeriod>\("DAY"\)/);
  assert.match(chartSource, /"DAY", "WEEK", "MONTH"/);
  assert.match(chartSource, /日次/);
  assert.match(chartSource, /週次/);
  assert.match(chartSource, /月次/);
  assert.match(chartSource, /クリック/);
  assert.match(chartSource, /CV \/ CVR/);
  assert.match(chartSource, /当月・720時間帰属・全RPP/);
  assert.match(chartSource, /週次・月次は取得済み日の合計/);
  assert.match(chartSource, /className="rpp-period-tabs"/);
  assert.match(chartSource, /aria-pressed=\{period === value\}/);
  assert.match(styles, /\.rpp-period-tabs \{[^}]*border-radius: 10px[^}]*background: #f1eeee/);
  assert.match(styles, /\.rpp-period-tabs button\.active \{[^}]*background: #fff[^}]*color: #dc2626/);
  assert.match(chartSource, /const hasObserved = rows\.some/);
  assert.match(chartSource, /\{hasObserved \? <>/);
  assert.match(chartSource, /hasObserved && roasPoints\.length/);
});
