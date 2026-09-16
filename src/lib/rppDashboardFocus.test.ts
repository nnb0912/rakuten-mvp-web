import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.join(process.cwd(), "src/app/rpp/page.tsx"), "utf8");
const chartSource = readFileSync(path.join(process.cwd(), "src/app/rpp/RppDashboardCharts.tsx"), "utf8");
const proposalSource = readFileSync(path.join(process.cwd(), "src/app/rpp/RppProposalLog.tsx"), "utf8");
const generatorSource = readFileSync(path.join(process.cwd(), "scripts/rpp-product-delivery/rpp_auto_recommendations.js"), "utf8");
const styles = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

test("ダッシュボードは固定以外の選択モードを主表示する", () => {
  assert.match(source, /自動モードの商品/);
  assert.match(source, /isAutomaticRppOptimizationMode/);
  assert.match(source, /automaticTargets/);

  assert.match(source, /ROAS・検索順位・バランスを選択した設定行/);
  assert.match(source, /automaticTargets\.map/);
  assert.match(source, /target\.keyword/);
  assert.match(source, /商品番号による制限はありません/);
  assert.doesNotMatch(source, /自動モード商品<\/span>|現在稼働<\/span>|excludedAutomaticProducts/);
  assert.match(chartSource, /label="広告経由売上"/);
  assert.doesNotMatch(source, /allowedItemCodes|自動調整を許可した商品|R0445・R0406だけが対象/);
});

test("商品観測がない自動モード商品は広告ONと表示しない", () => {
  assert.match(source, /!row\.product \? "未確認"/);
  assert.match(source, /!row\.product \? \{ label: "未確認"/);
  assert.match(source, /商品状態の実測待ち/);
});

test("売上とROASは720時間帰属を画面とARIAに明記する", () => {
  assert.match(chartSource, /attribution === "720H" \? "720時間帰属" : "12時間帰属"/);
  assert.match(chartSource, /ROAS集計時間/);
  assert.match(chartSource, />720時間<\/button>/);
  assert.match(chartSource, />12時間<\/button>/);
  assert.match(chartSource, /"720時間帰属"/);
  assert.match(chartSource, /"12時間帰属"/);
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

test("グラフは日次週次月次、KPIは期間と720・12時間帰属を切替える", () => {
  assert.match(source, /readRppDashboardDailyMetrics\(366\)/);
  assert.match(chartSource, /useState<RppChartPeriod>\("DAY"\)/);
  assert.match(chartSource, /"DAY", "WEEK", "MONTH"/);
  assert.match(chartSource, /日次/);
  assert.match(chartSource, /週次/);
  assert.match(chartSource, /月次/);
  assert.match(chartSource, /クリック/);
  assert.match(chartSource, /CV \/ CVR/);
  assert.match(chartSource, /useState<RppKpiPeriod>\("MONTH"\)/);
  assert.match(chartSource, /useState<RppKpiAttribution>\("720H"\)/);
  assert.match(chartSource, /対象データ期間/);
  assert.match(chartSource, /週次・月次は取得済み日の合計/);
  assert.match(chartSource, /className="rpp-period-tabs"/);
  assert.match(chartSource, /aria-pressed=\{period === value\}/);
  assert.match(styles, /\.rpp-period-tabs \{[^}]*border-radius: 10px[^}]*background: #f1eeee/);
  assert.match(styles, /\.rpp-period-tabs button\.active \{[^}]*background: #fff[^}]*color: #dc2626/);
  assert.match(chartSource, /const hasObserved = rows\.some/);
  assert.match(chartSource, /\{hasObserved \? <>/);
  assert.match(chartSource, /hasObserved && roasPoints\.length/);
});

test("スマホのKPIとグラフ見出しは横幅を有効利用する", () => {
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.rpp-chart-kpis \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.rpp-chart-heading \{[^}]*display: grid;[^}]*gap: 8px/);
  assert.match(styles, /\.rpp-period-tabs \{[^}]*justify-content: stretch/);
  assert.match(styles, /\.rpp-chart-legend span \{[^}]*white-space: nowrap/);
});

test("PCの6KPIは参考画面どおり3列2段に揃える", () => {
  assert.match(styles, /\.rpp-chart-kpis \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);[^}]*gap: 8px/);
});

test("調整提案ログはダッシュボードの自動モード商品より上に置く", () => {
  const proposalPosition = source.indexOf("<RppProposalLog");
  const automaticProductsPosition = source.indexOf("<h2>自動モードの商品</h2>");
  const budgetPosition = source.indexOf('view === "budget"');
  assert.ok(proposalPosition > 0);
  assert.ok(automaticProductsPosition > proposalPosition);
  assert.ok(budgetPosition > automaticProductsPosition);
  assert.match(proposalSource, /調整提案ログ/);
  assert.match(proposalSource, /RMS反映前の調整候補/);
  assert.match(proposalSource, /RPP広告ONの全商品を判定/);
  assert.match(proposalSource, /判定対象：広告ON/);
  assert.match(source, /rppOnRecommendations = data\.recommendations\.filter/);
  assert.match(source, /<RppProposalLog rows=\{rppOnRecommendations\}/);
  assert.match(generatorSource, /analyze\(eligibleByExclusion, perfMap\)/);
  assert.match(generatorSource, /activeRows: automatic\.length/);
  assert.match(generatorSource, /proposalScopeRows: eligibleByExclusion\.length/);
  assert.match(proposalSource, /全て/);
  assert.match(proposalSource, /引き上げ/);
  assert.match(proposalSource, /引き下げ/);
  assert.match(proposalSource, /除外/);
  assert.match(proposalSource, /調整前CPC/);
  assert.match(proposalSource, /調整後CPC/);
  assert.match(proposalSource, /対象・理由/);
  assert.match(proposalSource, /reason\.startsWith\("最適化モード:"\)/);
  assert.match(proposalSource, /reason\.startsWith\("保護区分:"\)/);
  assert.match(proposalSource, /<b>理由：<\/b>\{proposalReason\(row\)\}/);
  assert.match(proposalSource, /設定した固定CPC/);
  assert.match(proposalSource, /に対して現在/);
});
