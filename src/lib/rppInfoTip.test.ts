import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const rppDir = join(process.cwd(), "src", "app", "rpp");
const files = [
  "RppApprovalTable.tsx",
  "RppAutoAdjustmentSettingsPanel.tsx",
  "RppBudgetPanel.tsx",
  "RppPeriodComparison.tsx",
  "RppRemoveSettingCandidateExportButton.tsx",
  "RppStrategyPanel.tsx",
  "RppTargetSettings.tsx",
  "page.tsx",
];

test("RPPの静的な表見出しにはすべて説明アイコンがある", () => {
  const uncovered: string[] = [];
  let count = 0;
  for (const file of files) {
    const source = readFileSync(join(rppDir, file), "utf8");
    for (const match of source.matchAll(/<th[^>]*>([^{<][^<]*?)<\/th>/g)) {
      uncovered.push(`${file}: ${match[1].trim()}`);
    }
    count += (source.match(/<th[^>]*><RppInfoTip label=/g) ?? []).length;
  }
  assert.deepEqual(uncovered, []);
  assert.ok(count >= 57, `説明付き表見出しが不足しています: ${count}`);
});

test("RPPの主要KPIと設定項目にも説明アイコンがある", () => {
  const source = files.map((file) => readFileSync(join(rppDir, file), "utf8")).join("\n");
  const count = (source.match(/<RppInfoTip label=/g) ?? []).length;
  assert.ok(count >= 90, `説明アイコンが不足しています: ${count}`);
  for (const label of ["ROAS", "検索順位", "配信", "月末着地予測", "目標ROAS", "RPP設定KW", "保護区分"]) {
    assert.match(source, new RegExp(`<RppInfoTip label="${label}"`), `${label}の説明がありません`);
  }
});

test("説明アイコンはhover・キーボード・タッチ確認に対応する", () => {
  const component = readFileSync(join(rppDir, "RppInfoTip.tsx"), "utf8");
  assert.match(component, /tabIndex=\{0\}/);
  assert.match(component, /aria-label=/);
  assert.match(component, /title=\{description\}/);
  assert.match(component, /role="tooltip"/);
  assert.match(component, /onMouseEnter=/);
  assert.match(component, /onFocus=/);
  assert.match(component, /onClick=/);
});

test("説明はbody直下の固定レイヤーに出し、表や画面端で切れない", () => {
  const component = readFileSync(join(rppDir, "RppInfoTip.tsx"), "utf8");
  const css = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");
  assert.match(component, /createPortal/);
  assert.match(component, /document\.body/);
  assert.match(component, /Math\.min/);
  assert.match(component, /Math\.max/);
  assert.match(css, /\.rpp-info-popover\s*\{[^}]*position:\s*fixed/s);
});

test("狭幅でもADant型一覧の判断列を隠さず、表内横スクロールにする", () => {
  const css = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");
  assert.doesNotMatch(css, /\.adant-ops-table th:nth-child\(3\)[^{]*\{\s*display:\s*none/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.optimization-summary-grid\s*\{[^}]*display:\s*flex[^}]*overflow-x:\s*auto/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.adant-ops-table \.product-col\s*\{[^}]*position:\s*static/s);
});

test("最適化サマリーのカード装飾を説明アイコン内部へ波及させない", () => {
  const css = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");
  assert.doesNotMatch(css, /\.optimization-summary-grid span\s*\{[^}]*padding:/s);
  assert.match(css, /\.optimization-summary-grid > span\s*\{[^}]*padding:/s);
});

test("画面の見方はRPPメニューの一番下に置く", () => {
  const page = readFileSync(join(rppDir, "page.tsx"), "utf8");
  const views = page.slice(page.indexOf("const RPP_VIEWS"), page.indexOf("} as const;"));
  assert.ok(views.indexOf("data:") < views.indexOf("guide:"), "画面の見方がメニュー末尾ではありません");
});

test("画面の見方から使い方マニュアル動画を再生できる", () => {
  const page = readFileSync(join(rppDir, "page.tsx"), "utf8");
  const css = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");
  const video = join(process.cwd(), "public", "rpp", "manuals", "rpp-control-guide-v6.mp4");
  assert.match(page, /<video[^>]*controls[^>]*playsInline/s);
  assert.match(page, /src="\/rpp\/manuals\/rpp-control-guide-v6\.mp4"/);
  assert.match(page, /全利用者向け 使い方マニュアル動画/);
  assert.match(css, /\.rpp-guide-video\s+video\s*\{[^}]*width:\s*100%/s);
  assert.ok(readFileSync(video).length > 1_000_000, "動画ファイルが存在しないか小さすぎます");
});
