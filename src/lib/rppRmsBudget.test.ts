import assert from "node:assert/strict";
import test from "node:test";
import type { RppRmsBudgetObservation } from "./rppDashboardSnapshots.ts";
import { resolveRppRmsBudget } from "./rppRmsBudget.ts";

function complete(observedAt: string): RppRmsBudgetObservation {
  return { version: 1, status: "COMPLETE", attemptedAt: observedAt, observedAt, asOfDate: "2026-09-15", source: "RMS_RPP_TOP_AND_CAMPAIGNS", currency: "JPY", campaignCount: 4, activeCampaignCount: 1, effectiveBudget: 5_000_000, continuingBudget: 8_253_154, activeCampaignBudgetTotal: 5_000_000, allCampaignBudgetTotal: 8_253_154, complete: true };
}

test("RMS予算は3時間以内の完全観測だけREADYになる", () => {
  const now = Date.parse("2026-09-16T04:00:00Z");
  assert.equal(resolveRppRmsBudget(complete("2026-09-16T03:00:00Z"), now).state, "READY");
  assert.equal(resolveRppRmsBudget(complete("2026-09-16T00:59:59Z"), now).state, "STALE");
  assert.equal(resolveRppRmsBudget(complete("2026-09-16T04:00:00.001Z"), now).state, "FUTURE");
  assert.equal(resolveRppRmsBudget(null, now).state, "MISSING");
});

test("UNKNOWN観測の金額は予算として使用しない", () => {
  const unknown: RppRmsBudgetObservation = { ...complete("2026-09-16T03:00:00Z"), status: "UNKNOWN", observedAt: null, asOfDate: null, campaignCount: null, activeCampaignCount: null, effectiveBudget: null, continuingBudget: null, activeCampaignBudgetTotal: null, allCampaignBudgetTotal: null, complete: false };
  assert.equal(resolveRppRmsBudget(unknown, Date.parse("2026-09-16T04:00:00Z")).state, "UNKNOWN");
});
