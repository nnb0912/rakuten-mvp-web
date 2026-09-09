import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.join(process.cwd(), "src/app/rpp/page.tsx"), "utf8");

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
