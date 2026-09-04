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
