import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canDownloadManualCpcCsv, isAutomaticRppOptimizationMode } from "./rppCpcModePolicy.ts";

const targets = readFileSync(new URL("./rppTargets.ts", import.meta.url), "utf8");

test("商品番号に関係なく選択モードで自動運用を決める", () => {
  for (const mode of ["ROAS", "POSITION", "BALANCED"] as const) {
    assert.equal(isAutomaticRppOptimizationMode(mode), true);
    assert.equal(canDownloadManualCpcCsv(mode), false);
  }
  assert.equal(isAutomaticRppOptimizationMode("FIXED"), false);
  assert.equal(canDownloadManualCpcCsv("FIXED"), true);
});

test("任意の商品で自動モードを保存できる", () => {
  assert.match(targets, /const optimizationMode = normalizeRppOptimizationMode\(input\.optimizationMode\)/);
  assert.doesNotMatch(targets, /RPP_AUTO_CPC_ITEM_CODES|assertRppOptimizationModeAllowed|isRppAutoCpcItem/);
});

test("未設定行は固定で開始し、固定だけ手動CSVを表示する", () => {
  const component = readFileSync(new URL("../app/rpp/RppTargetSettings.tsx", import.meta.url), "utf8");

  assert.match(component, /const availableOptimizationModes = ROUTINE_OPTIMIZATION_MODES/);
  assert.match(component, /optimizationMode: "FIXED", fixedCpc:/);
  assert.match(component, /canDownloadManualCpcCsv\(effectiveMode\)/);
  assert.match(component, /選択したモードに従って自動調整します/);
  assert.doesNotMatch(component, /R0445・R0406以外は自動調整対象外/);
  assert.match(targets, /defaultOptimizationMode = defaults\.optimizationMode \? normalizeRppOptimizationMode\(defaults\.optimizationMode\) : "FIXED"/);
  assert.match(targets, /optimization_mode text not null default 'FIXED'/);
  assert.doesNotMatch(targets, /assertRppOptimizationModeAllowed|isRppAutoCpcItem/);
});
