import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../app/rpp/page.tsx", import.meta.url), "utf8");
const nav = readFileSync(new URL("../app/rpp/RppConsoleNav.tsx", import.meta.url), "utf8");
const targets = readFileSync(new URL("../app/rpp/RppTargetSettings.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("モバイルナビは現在画面を表示範囲へ移動する", () => {
  assert.match(page, /<RppConsoleNav activeView=\{view\}/);
  assert.match(nav, /matchMedia\("\(max-width: 760px\)"\)/);
  assert.match(nav, /querySelector<HTMLElement>\('\[aria-current="page"\]'\)/);
  assert.match(nav, /scrollIntoView\(\{ block: "nearest", inline: "center" \}\)/);
});

test("除外画面は操作を切らず一覧を内部スクロールにする", () => {
  assert.match(styles, /\.rpp-console-main \.target-panel \{ overflow: visible/);
  assert.match(styles, /\.excluded-product-page \.excluded-product-grid \{[\s\S]*overflow-y: auto/);
  assert.match(styles, /\.excluded-product-row \.excluded-actions \{[^}]*flex-wrap: wrap/);
  assert.match(styles, /\.excluded-product-page \.excluded-actions button \{ min-height: 36px/);
  assert.match(targets, /useState\(50\)/);
  assert.match(targets, /excludedProductsForOwner\.slice\(0, excludedVisibleCount\)/);
  assert.match(targets, /setExcludedVisibleCount\(\(count\) => count \+ 50\)/);
  assert.match(targets, /さらに50件表示/);
  assert.match(targets, /role="status" aria-live="polite"/);
  assert.match(targets, /全件表示済み/);
});

test("予算・最適化・ガイドは中間幅と狭幅で切れない", () => {
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*\.budget-metric-grid \{ grid-template-columns: repeat\(2/);
  assert.match(styles, /@media \(max-width: 1180px\)[\s\S]*#rpp-optimization \.auto-number-grid \{ grid-template-columns: repeat\(3/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*#rpp-optimization \.auto-number-grid \{ grid-template-columns: repeat\(2/);
  assert.match(styles, /\.rpp-console-main \.rpp-guide-video \{ grid-template-columns: 1fr/);
});

test("データ鮮度と監査ログは欠落せず閲覧できる", () => {
  assert.match(styles, /\.rpp-console-main \.ops-grid \{ grid-template-columns: 1fr/);
  assert.match(styles, /\.meta-list li > small \{[^}]*overflow-wrap: anywhere/);
  assert.match(page, /<div className="rpp-audit-table-wrap"><table/);
  assert.match(styles, /\.rpp-audit-table-wrap \{ width: 100%; overflow-x: auto/);
  assert.match(styles, /\.rpp-audit-table-wrap table \{ min-width: 760px/);
});
