import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertRppOptimizationModeAllowed,
  canDownloadManualCpcCsv,
  effectiveRppOptimizationMode,
  isRppAutoCpcItem,
} from "./rppCpcModePolicy.ts";

test("R0445とR0406だけをCPC自動調整対象として扱う", () => {
  assert.equal(isRppAutoCpcItem(" R0445 "), true);
  assert.equal(isRppAutoCpcItem("r0406"), true);
  assert.equal(isRppAutoCpcItem("c017"), false);
  assert.equal(canDownloadManualCpcCsv("r0445"), false);
  assert.equal(canDownloadManualCpcCsv("c017"), true);
});

test("自動化対象外はCPC固定モードへ固定し、保存時にも拒否する", () => {
  assert.equal(effectiveRppOptimizationMode("r0445", "BALANCED"), "BALANCED");
  assert.equal(effectiveRppOptimizationMode("c017", "ROAS"), "FIXED");
  assert.doesNotThrow(() => assertRppOptimizationModeAllowed("c017", "FIXED"));
  assert.throws(() => assertRppOptimizationModeAllowed("c017", "ROAS"), /R0445・R0406以外/);
});

test("一覧は自動対象の手動CPC操作を隠し、対象外をCPC変更CSVと明記する", () => {
  const component = readFileSync(new URL("../app/rpp/RppTargetSettings.tsx", import.meta.url), "utf8");
  const targets = readFileSync(new URL("./rppTargets.ts", import.meta.url), "utf8");
  assert.match(component, /canDownloadManualCpcCsv\(cfg\.itemCode\)/);
  assert.match(component, />CPC変更CSV<\/button>/);
  assert.match(component, />自動管理<\/span>/);
  assert.match(targets, /assertRppOptimizationModeAllowed\(itemCode, optimizationMode\)/);
  assert.match(targets, /optimizationMode: isRppAutoCpcItem\(row\.itemCode\) \? defaults\.optimizationMode : "FIXED"/);
});