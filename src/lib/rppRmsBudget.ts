import type { RppRmsBudgetObservation } from "./rppDashboardSnapshots.ts";

export type RppRmsBudgetState = "READY" | "MISSING" | "UNKNOWN" | "STALE" | "FUTURE";

export type ResolvedRppRmsBudget = {
  state: RppRmsBudgetState;
  observation: RppRmsBudgetObservation | null;
};

const MAX_AGE_MS = 3 * 60 * 60_000;

export function resolveRppRmsBudget(observation: RppRmsBudgetObservation | null | undefined, nowMs = Date.now()): ResolvedRppRmsBudget {
  if (!observation) return { state: "MISSING", observation: null };
  if (observation.status !== "COMPLETE" || observation.complete !== true || observation.observedAt == null) return { state: "UNKNOWN", observation };
  const observedMs = new Date(observation.observedAt).getTime();
  if (!Number.isFinite(observedMs) || observedMs > nowMs) return { state: "FUTURE", observation };
  if (nowMs - observedMs > MAX_AGE_MS) return { state: "STALE", observation };
  return { state: "READY", observation };
}
