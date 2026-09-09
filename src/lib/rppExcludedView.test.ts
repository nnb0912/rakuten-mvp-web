import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../app/rpp/page.tsx", import.meta.url), "utf8");
const component = readFileSync(new URL("../app/rpp/RppTargetSettings.tsx", import.meta.url), "utf8");

test("除外中・広告ON戻しはURL付きの独立メニューで開く", () => {
  assert.match(page, /excluded:\s*\{ label: "除外中・広告ON戻し"/);
  assert.match(page, /view === "products" \|\| view === "excluded"/);
  assert.match(page, /surface=\{view === "excluded" \? "excluded" : "targets"\}/);
  assert.match(page, /href="\/rpp\?view=excluded"/);
});

test("除外中画面は担当者タブで件数を表示し検索窓や開閉操作を使わない", () => {
  assert.match(component, /excludedOwnerStats\.map/);
  assert.match(component, /aria-label="除外中商品の担当者絞り込み"/);
  assert.match(component, /excludedProductsForOwner\.map/);
  assert.doesNotMatch(component, /setShowExcludedProducts|exclusionSearch|filteredExcludedProducts/);
});

test("商品・KW一覧から除外中商品ブロックを分離する", () => {
  assert.match(component, /surface === "targets" \? <section className="panel product-card-panel">/);
  assert.match(component, /: <section className="panel excluded-product-block excluded-product-page"/);
  assert.match(component, /surface === "targets" \? <section className="panel experiment-history-panel"/);
});
