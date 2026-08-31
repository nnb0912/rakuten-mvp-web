import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRppBudgetSettings } from "./rppBudgetSettings.ts";

test("RPP budget settings are normalized and RMS sync stays off", () => {
  const settings = normalizeRppBudgetSettings({ monthlyBudget: 4_852_554, warningPercent: 88, targetRoas: 550, rmsBudgetSync: true as never });
  assert.equal(settings.monthlyBudget, 4_852_554);
  assert.equal(settings.warningPercent, 88);
  assert.equal(settings.targetRoas, 550);
  assert.equal(settings.rmsBudgetSync, false);
});

test("RPP budget settings reject negative numeric input with safe defaults", () => {
  const settings = normalizeRppBudgetSettings({ monthlyBudget: -1, warningPercent: -1 });
  assert.equal(settings.monthlyBudget, 0);
  assert.equal(settings.warningPercent, 90);
});