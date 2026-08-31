import type { RppBudgetMetrics, RppBudgetSettings, RppDailyBudgetPlanRow } from "./rppBudgetSettings";

function monthParts(value: Date) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = Object.fromEntries(formatter.formatToParts(value).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day };
}
function allocateExact(total: number, weights: number[]) {
  const safeTotal = Math.max(0, Math.round(total));
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  if (!weights.length) return [];
  if (weightTotal <= 0) return weights.map(() => 0);
  const raw = weights.map((weight) => safeTotal * weight / weightTotal);
  const result = raw.map(Math.floor);
  const remainder = safeTotal - result.reduce((sum, value) => sum + value, 0);
  const order = raw.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; index < remainder; index += 1) result[order[index % order.length].index] += 1;
  return result;
}
export function calculateRppDailyBudgetPlan(settings: RppBudgetSettings, metrics: RppBudgetMetrics | null, now = new Date()): RppDailyBudgetPlanRow[] {
  const current = monthParts(now);
  const daysInMonth = new Date(Date.UTC(current.year, current.month, 0)).getUTCDate();
  const actualMap = new Map((metrics?.dailyActuals ?? []).map((row) => [row.date, Math.max(0, Math.round(Number(row.spend) || 0))]));
  const activeWeights = Array.from({ length: daysInMonth }, (_, index) => settings.allocationMode === "FLAT" ? 1 : Math.max(0, Number(settings.dailyWeights[index]) || 0));
  const totalWeight = activeWeights.reduce((sum, value) => sum + value, 0) || daysInMonth;
  const measuredThrough = Array.from(actualMap.keys()).sort().at(-1) ?? null;
  const cutoffDay = measuredThrough ? Number(measuredThrough.slice(-2)) : 0;
  const basePlan = allocateExact(settings.monthlyBudget, activeWeights);
  const plannedAmounts = [...basePlan];
  if (settings.redistributeRemaining && cutoffDay > 0) {
    let fixed = 0;
    for (let index = 0; index < cutoffDay; index += 1) {
      const date = `${current.year}-${String(current.month).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`;
      plannedAmounts[index] = actualMap.get(date) ?? basePlan[index];
      fixed += plannedAmounts[index];
    }
    const future = allocateExact(Math.max(0, settings.monthlyBudget - fixed), activeWeights.slice(cutoffDay));
    future.forEach((value, index) => { plannedAmounts[cutoffDay + index] = value; });
  }
  let cumulativePlan = 0;
  let cumulativeActual = 0;
  return activeWeights.map((weight, index) => {
    const day = index + 1;
    const date = `${current.year}-${String(current.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const plannedBudget = plannedAmounts[index];
    const actualSpend = actualMap.get(date) ?? null;
    cumulativePlan += plannedBudget;
    if (actualSpend != null) cumulativeActual += actualSpend;
    const variance = actualSpend == null ? null : actualSpend - plannedBudget;
    const isFuture = day > current.day;
    return { date, day, weightPercent: Math.round(weight / totalWeight * 100000) / 1000, plannedBudget, actualSpend, variance, cumulativePlan, cumulativeActual: actualSpend == null && !measuredThrough ? null : cumulativeActual, state: isFuture ? "future" : actualSpend == null || variance == null ? "unmeasured" : variance > plannedBudget * .1 ? "over" : variance < -plannedBudget * .1 ? "under" : "ok" };
  });
}
