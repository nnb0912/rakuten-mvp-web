import { promises as fs } from "fs";
import path from "path";
import { pool } from "./db.ts";

export type RppBudgetSettings = {
  monthlyBudget: number;
  warningPercent: number;
  targetRoas: number;
  rmsBudgetSync: false;
  updatedAt: string | null;
};

export type RppBudgetMetrics = {
  dateRange?: string;
  days?: number;
  spend?: number;
  sales?: number;
  clicks?: number;
  orders?: number;
  roas?: number | null;
  dailyAverage?: number;
  projectedMonthlySpend?: number;
  source?: string;
};

const DEFAULTS: RppBudgetSettings = {
  monthlyBudget: 0,
  warningPercent: 90,
  targetRoas: 500,
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

export function normalizeRppBudgetSettings(input: Partial<RppBudgetSettings> = {}): RppBudgetSettings {
  return {
    monthlyBudget: numberValue(input.monthlyBudget, DEFAULTS.monthlyBudget),
    warningPercent: numberValue(input.warningPercent, DEFAULTS.warningPercent, 1),
    targetRoas: numberValue(input.targetRoas, DEFAULTS.targetRoas),
    rmsBudgetSync: false,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : null,
  };
}

async function ensureTable() {
  if (!pool) return;
  await pool.query(`create table if not exists ${TABLE} (
    singleton boolean primary key default true check (singleton),
    monthly_budget integer not null default 0,
    warning_percent integer not null default 90,
    target_roas integer not null default 500,
    rms_budget_sync boolean not null default false,
    updated_at timestamptz not null default now()
  )`);
}

export async function readRppBudgetSettings() {
  if (pool) {
    await ensureTable();
    const result = await pool.query(`select monthly_budget, warning_percent, target_roas, updated_at from ${TABLE} where singleton=true`);
    const row = result.rows[0];
    if (row) return { source: `db:${TABLE}`, settings: normalizeRppBudgetSettings({ monthlyBudget: row.monthly_budget, warningPercent: row.warning_percent, targetRoas: row.target_roas, updatedAt: new Date(row.updated_at).toISOString() }) };
  }
  try {
    return { source: FILE_PATH, settings: normalizeRppBudgetSettings(JSON.parse(await fs.readFile(FILE_PATH, "utf8"))) };
  } catch {
    return { source: pool ? `db:${TABLE}` : FILE_PATH, settings: DEFAULTS };
  }
}

export async function writeRppBudgetSettings(input: Partial<RppBudgetSettings>) {
  const settings = normalizeRppBudgetSettings({ ...input, updatedAt: new Date().toISOString() });
  if (settings.warningPercent > 200) throw new Error("警告ラインは200%以下にしてください");
  if (pool) {
    await ensureTable();
    await pool.query(`insert into ${TABLE} (singleton, monthly_budget, warning_percent, target_roas, rms_budget_sync, updated_at)
      values (true,$1,$2,$3,false,now()) on conflict (singleton) do update set monthly_budget=$1, warning_percent=$2, target_roas=$3, rms_budget_sync=false, updated_at=now()`,
      [settings.monthlyBudget, settings.warningPercent, settings.targetRoas]);
    return readRppBudgetSettings();
  }
  await fs.mkdir(path.dirname(FILE_PATH), { recursive: true });
  await fs.writeFile(FILE_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return { source: FILE_PATH, settings };
}
