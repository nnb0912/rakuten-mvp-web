import assert from "node:assert/strict";
import test from "node:test";
import { validateRppTargetInputValues, type RppTargetValidationInput } from "./rppTargetValidation.ts";

const base: RppTargetValidationInput = {
  ctrGoal: 5, cvrGoal: 5, roasFloor: 600, optimizationMode: "ROAS",
  pcPositionGoal: "TOP_3", spPositionGoal: "TOP_3",
};

test("RPP目標保存は未知モード・負数・PC7位を拒否する", () => {
  assert.throws(() => validateRppTargetInputValues({ ...base, optimizationMode: "UNKNOWN" }), /運用モードが不正/);
  assert.throws(() => validateRppTargetInputValues({ ...base, ctrGoal: -1 }), /正数/);
  assert.throws(() => validateRppTargetInputValues({ ...base, roasMinCpc: -1 }), /正数/);
  assert.throws(() => validateRppTargetInputValues({ ...base, pcPositionGoal: "TOP_7" }), /PC順位目標/);
});

test("固定CPCと商品別上限は120円を超えて保存できる", () => {
  assert.throws(() => validateRppTargetInputValues({ ...base, optimizationMode: "FIXED", fixedCpc: null }), /固定CPCが必須/);
  assert.doesNotThrow(() => validateRppTargetInputValues({ ...base, optimizationMode: "FIXED", fixedCpc: 250 }));
  assert.doesNotThrow(() => validateRppTargetInputValues({ ...base, maxCpc: 300, balancedMaxCpc: 280 }));
});