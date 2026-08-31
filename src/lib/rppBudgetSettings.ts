import { promises as fs } from "fs";
import path from "path";
import { pool } from "./db.ts";
import { appendRppAuditEvent } from "./rppAuditLog.ts";

export type RppBudgetAllocationMode = "FLAT" | "MANUAL";

export type RppDailyActual = {
  date: string;
  spend: number;
  sales?: number;
  clicks?: number;
  orders?: number;
  source?: string;
  salesWindow?: string;
};

export type RppBudgetSettings = {
  monthlyBudget: number;
  nextMonthBudget: number;
  warningPercent: number;
  targetRoas: number;
  allocationMode: RppBudgetAllocationMode;
  dailyWeights: number[];
  redistributeRemaining: boolean;
  rmsBudgetSync: false;
  updatedAt: string | null;
};

export type RppBudgetMetrics = {
  dateRange?: string;
  days?: number;
  spend?: number;
  monthSpend?: number;
  sales?: number;
  clicks?: number;
  orders?: number;
  roas?: number | null;
  dailyAverage?: number;
  projectedMonthlySpend?: number;
  dailyActuals?: RppDailyActual[];
  source?: string;
};

export type RppDailyBudgetPlanRow = {
  date: string;
  day: number;
  weightPercent: number;
  plannedBudget: number;
  actualSpend: number | null;
  variance: number | null;
  cumulativePlan: number;
  cumulativeActual: number | null;
  state: "future" | "ok" | "over" | "under" | "unmeasured";
};

const DEFAULT_WEIGHTS = Array.from({ length: 31 }, () => 1);
const DEFAULTS: RppBudgetSettings = {
  monthlyBudget: 0,
  nextMonthBudget: 0,
  warningPercent: 90,
  targetRoas: 500,
  allocationMode: "FLAT",
  dailyWeights: DEFAULT_WEIGHTS,
  redistributeRemaining: false,
  rmsBudgetSync: false,
  updatedAt: null,
};
const TABLE = "rpp_budget_settings";
const PROJECT_DIR = process.env.RPP_PROJECT_DIR ?? (process.platform === "darwin" ? "/Users/nob/Projects/rpp-8am-notify" : "/tmp/rpp-8am-notify");
const FILE_PATH = path.join(PROJECT_DIR, "rpp_targets", "rpp_budget_settings.json");

function numberValue(value: unknown, fallback: number, min = 0) {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(parsed) && parsed >= min ? Math.round(parsed) : fallback;
}

function normalizeWeights(value: unknown) {
  const rows = Array.isArray(value) ? value.slice(0, 31) : [];
  return Array.from({ length: 31 }, (_, index) => {
    const parsed = Number(rows[index] ?? 1);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1000) / 1000 : 1;
  });
}

export function normalizeRppBudgetSettings(input: Partial<RppBudgetSettings> = {}): RppBudgetSettings {
  return {
    monthlyBudget: numberValue(input.monthlyBudget, DEFAULTS.monthlyBudget),
    nextMonthBudget: numberValue(input.nextMonthBudget, DEFAULTS.nextMonthBudget),
    warningPercent: numberValue(input.warningPercent, DEFAULTS.warningPercent, 1),
    targetRoas: numberValue(input.targetRoas, DEFAULTS.targetRoas),
    allocationMode: input.allocationMode === "MANUAL" ? "MANUAL" : "FLAT",
    dailyWeights: normalizeWeights(input.dailyWeights),
    redistributeRemaining: input.redistributeRemaining === true,
    rmsBudgetSync: false,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : null,
  };
}

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
  for (let i = 0; i < remainder; i += 1) result[order[i % order.length].index] += 1;
  return result;
}

export function calculateRppDailyBudgetPlan(settingsInput: Partial<RppBudgetSettings>, metrics: RppBudgetMetrics | null, now = new Date()): RppDailyBudgetPlanRow[] {
  const settings = normalizeRppBudgetSettings(settingsInput);
  const current = monthParts(now);
  const daysInMonth = new Date(Date.UTC(current.year, current.month, 0)).getUTCDate();
  const actualMap = new Map((metrics?.dailyActuals ?? []).map((row) => [row.date, Math.max(0, Math.round(Number(row.spend) || 0))]));
  const activeWeights = Array.from({ length: daysInMonth }, (_, index) => settings.allocationMode === "FLAT" ? 1 : settings.dailyWeights[index]);
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
    return {
      date,
      day,
      weightPercent: Math.round(weight / totalWeight * 100000) / 1000,
      plannedBudget,
      actualSpend,
      variance,
      cumulativePlan,
      cumulativeActual: actualSpend == null && !measuredThrough ? null : cumulativeActual,
      state: isFuture ? "future" : actualSpend == null || variance == null ? "unmeasured" : variance > plannedBudget * 0.1 ? "over" : variance < -plannedBudget * 0.1 ? "under" : "ok",
    };
  });
}

async function ensureTable() {
  if (!pool) return;
  await pool.query(`create table if not exists ${TABLE} (
    singleton boolean primary key default true check (singleton),
    monthly_budget integer not null default 0,
    warning_percent integer not null default 90,
    target_roas integer not null default 500,
    rms_budget_sync boolean not null default false check (rms_budget_sync = false),
    updated_at timestamptz not null default now()
  )`);
  await pool.query(`alter table ${TABLE} add column if not exists next_month_budget integer not null default 0`);
  await pool.query(`alter table ${TABLE} add column if not exists allocation_mode text not null default 'FLAT'`);
  await pool.query(`alter table ${TABLE} add column if not exists daily_weights jsonb not null default '[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]'::jsonb`);
  await pool.query(`alter table ${TABLE} add column if not exists redistribute_remaining boolean not null default false`);
  await pool.query(`update ${TABLE} set rms_budget_sync=false where rms_budget_sync<>false`);
  await pool.query(`do $$ begin if not exists (select 1 from pg_constraint where conname='${TABLE}_rms_sync_false') then alter table ${TABLE} add constraint ${TABLE}_rms_sync_false check (rms_budget_sync=false); end if; end $$`);
}

export async function readRppBudgetSettings() {
  if (pool) {
    await ensureTable();
    const result = await pool.query(`select monthly_budget, next_month_budget, warning_percent, target_roas, allocation_mode, daily_weights, redistribute_remaining, updated_at from ${TABLE} where singleton=true`);
    const row = result.rows[0];
    if (row) return { source: `db:${TABLE}`, settings: normalizeRppBudgetSettings({ monthlyBudget: row.monthly_budget, nextMonthBudget: row.next_month_budget, warningPercent: row.warning_percent, targetRoas: row.target_roas, allocationMode: row.allocation_mode, dailyWeights: row.daily_weights, redistributeRemaining: row.redistribute_remaining, updatedAt: new Date(row.updated_at).toISOString() }) };
  }
  try {
    return { source: FILE_PATH, settings: normalizeRppBudgetSettings(JSON.parse(await fs.readFile(FILE_PATH, "utf8"))) };
  } catch {
    return { source: pool ? `db:${TABLE}` : FILE_PATH, settings: DEFAULTS };
  }
}

export async function writeRppBudgetSettings(input: Partial<RppBudgetSettings>, actorId = "system") {
  const settings = normalizeRppBudgetSettings({ ...input, updatedAt: new Date().toISOString() });
  if (settings.warningPercent > 200) throw new Error("警告ラインは200%以下にしてください");
  if (settings.allocationMode === "MANUAL" && settings.dailyWeights.every((value) => value === 0)) throw new Error("手動配分は1日以上の比率を入力してください");
  if (pool) {
    await ensureTable();
    await pool.query(`insert into ${TABLE} (singleton, monthly_budget, next_month_budget, warning_percent, target_roas, allocation_mode, daily_weights, redistribute_remaining, rms_budget_sync, updated_at)
      values (true,$1,$2,$3,$4,$5,$6::jsonb,$7,false,now()) on conflict (singleton) do update set monthly_budget=$1, next_month_budget=$2, warning_percent=$3, target_roas=$4, allocation_mode=$5, daily_weights=$6::jsonb, redistribute_remaining=$7, rms_budget_sync=false, updated_at=now()`,
      [settings.monthlyBudget, settings.nextMonthBudget, settings.warningPercent, settings.targetRoas, settings.allocationMode, JSON.stringify(settings.dailyWeights), settings.redistributeRemaining]);
    await appendRppAuditEvent("BUDGET_SETTINGS_UPDATED", "RPP予算計画", { monthlyBudget: settings.monthlyBudget, nextMonthBudget: settings.nextMonthBudget, warningPercent: settings.warningPercent, allocationMode: settings.allocationMode, redistributeRemaining: settings.redistributeRemaining, rmsBudgetSync: false }, actorId);
    return readRppBudgetSettings();
  }
  await fs.mkdir(path.dirname(FILE_PATH), { recursive: true });
  await fs.writeFile(FILE_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await appendRppAuditEvent("BUDGET_SETTINGS_UPDATED", "RPP予算計画", { monthlyBudget: settings.monthlyBudget, nextMonthBudget: settings.nextMonthBudget, warningPercent: settings.warningPercent, allocationMode: settings.allocationMode, redistributeRemaining: settings.redistributeRemaining, rmsBudgetSync: false }, actorId);
  return { source: FILE_PATH, settings };
}
