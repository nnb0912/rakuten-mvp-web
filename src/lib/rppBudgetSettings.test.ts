import assert from "node:assert/strict";
import test from "node:test";
import { calculateRppDailyBudgetPlan, normalizeRppBudgetSettings } from "./rppBudgetSettings.ts";

test("RPP budget settings are normalized and RMS sync stays off", () => {
  const settings = normalizeRppBudgetSettings({ monthlyBudget: 4_852_554, nextMonthBudget: 5_000_000, warningPercent: 88, targetRoas: 550, allocationMode: "MANUAL", dailyWeights: [2, 1], redistributeRemaining: true, rmsBudgetSync: true as never });
  assert.equal(settings.monthlyBudget, 4_852_554);
  assert.equal(settings.nextMonthBudget, 5_000_000);
  assert.equal(settings.warningPercent, 88);
  assert.equal(settings.targetRoas, 550);
  assert.equal(settings.allocationMode, "MANUAL");
  assert.deepEqual(settings.dailyWeights.slice(0, 3), [2, 1, 1]);
  assert.equal(settings.redistributeRemaining, true);
  assert.equal(settings.rmsBudgetSync, false);
});

test("RPP budget settings reject negative numeric input with safe defaults", () => {
  const settings = normalizeRppBudgetSettings({ monthlyBudget: -1, nextMonthBudget: -1, warningPercent: -1, dailyWeights: [-2] });
  assert.equal(settings.monthlyBudget, 0);
  assert.equal(settings.nextMonthBudget, 0);
  assert.equal(settings.warningPercent, 90);
  assert.equal(settings.dailyWeights[0], 1);
});

test("daily budget plan creates one row per month day without inventing actual spend", () => {
  const plan = calculateRppDailyBudgetPlan({ monthlyBudget: 3_100, allocationMode: "FLAT" }, null, new Date("2026-08-10T00:00:00+09:00"));
  assert.equal(plan.length, 31);
  assert.equal(plan[0].plannedBudget, 100);
  assert.equal(plan[0].actualSpend, null);
  assert.equal(plan[0].state, "unmeasured");
  assert.equal(plan[30].state, "future");
});

test("remaining budget is redistributed only when daily actuals exist", () => {
  const plan = calculateRppDailyBudgetPlan(
    { monthlyBudget: 3_100, allocationMode: "FLAT", redistributeRemaining: true },
    { dailyActuals: [{ date: "2026-08-01", spend: 200 }, { date: "2026-08-02", spend: 100 }] },
    new Date("2026-08-10T00:00:00+09:00"),
  );
  assert.equal(plan[0].actualSpend, 200);
  assert.equal(plan[1].actualSpend, 100);
  assert.equal(plan[2].plannedBudget, 97);
  assert.equal(plan[2].variance, null);
  assert.equal(plan.reduce((sum, row) => sum + row.plannedBudget, 0), 3_100);
});
