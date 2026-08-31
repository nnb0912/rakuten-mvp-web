import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pool } from "./db.ts";
import { getRppExperimentStatus, type RppExperimentStatus } from "./rppExperimentStatus.ts";

export type RppExperimentMode = "POSITION" | "FIXED";
export type RppExperimentPositionGoal = "FIRST_PAGE" | "TOP_7" | "TOP_5" | "TOP_3";

export type RppExperimentMetrics = {
  capturedAt: string;
  ctr: number | null;
  cvr: number | null;
  roas: number | null;
  pcPosition: string;
  spPosition: string;
};

export type RppExperimentSettingsSnapshot = {
  fixedCpc: number | null;
  maxCpc: number | null;
  pcPositionGoal: RppExperimentPositionGoal;
  spPositionGoal: RppExperimentPositionGoal;
  ctrGoal: number;
  cvrGoal: number;
  roasFloor: number;
};

export type RppExperimentRecord = {
  id: string;
  targetId: string;
  itemCode: string;
  keyword: string;
  optimizationMode: RppExperimentMode;
  endDate: string;
  startedAt: string;
  finishedAt: string;
  baseline: RppExperimentMetrics;
  settings: RppExperimentSettingsSnapshot;
  result: RppExperimentMetrics | null;
  note: string;
  createdAt: string;
  updatedAt: string;
  status: RppExperimentStatus;
};

export type StartRppExperimentInput = {
  targetId: string;
  itemCode: string;
  keyword: string;
  optimizationMode: RppExperimentMode;
  endDate: string;
  startedAt?: string;
  baseline: RppExperimentMetrics;
  settings: RppExperimentSettingsSnapshot;
};

export type FinishRppExperimentInput = {
  finishedAt?: string;
  result: RppExperimentMetrics;
  note?: string;
};

const TABLE = "rpp_experiment_history";
const POSITION_GOALS: RppExperimentPositionGoal[] = ["FIRST_PAGE", "TOP_7", "TOP_5", "TOP_3"];
let fallbackQueue: Promise<void> = Promise.resolve();

function projectDir() {
  return process.env.RPP_PROJECT_DIR ?? (process.platform === "darwin" ? "/Users/nob/Projects/rpp-8am-notify" : "/tmp/rpp-8am-notify");
}

function historyPath() {
  return path.join(projectDir(), "rpp_targets", "rpp_experiment_history.json");
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function timestamp(value: unknown, field: string) {
  const raw = text(value);
  const date = new Date(raw);
  if (!raw || Number.isNaN(date.getTime())) throw new Error(`${field}には有効な日時を指定してください`);
  return date.toISOString();
}

function dateOnly(value: unknown, field: string) {
  const raw = text(value);
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new Error(`${field}はYYYY-MM-DD形式で指定してください`);
  }
  return raw;
}

function nullableMetric(value: unknown, field: string) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${field}は0以上の数値またはnullで指定してください`);
  return number;
}

function positiveNumber(value: unknown, field: string, nullable = false) {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${field}は0より大きい数値で指定してください`);
  return number;
}

function normalizeMetrics(value: RppExperimentMetrics, field: string): RppExperimentMetrics {
  if (!value || typeof value !== "object") throw new Error(`${field}は必須です`);
  return {
    capturedAt: timestamp(value.capturedAt, `${field}.capturedAt`),
    ctr: nullableMetric(value.ctr, `${field}.ctr`),
    cvr: nullableMetric(value.cvr, `${field}.cvr`),
    roas: nullableMetric(value.roas, `${field}.roas`),
    pcPosition: text(value.pcPosition),
    spPosition: text(value.spPosition),
  };
}

function normalizeSettings(value: RppExperimentSettingsSnapshot): RppExperimentSettingsSnapshot {
  if (!value || typeof value !== "object") throw new Error("settingsは必須です");
  if (!POSITION_GOALS.includes(value.pcPositionGoal) || !POSITION_GOALS.includes(value.spPositionGoal)) {
    throw new Error("settingsの順位目標が不正です");
  }
  return {
    fixedCpc: positiveNumber(value.fixedCpc, "settings.fixedCpc", true),
    maxCpc: positiveNumber(value.maxCpc, "settings.maxCpc", true),
    pcPositionGoal: value.pcPositionGoal,
    spPositionGoal: value.spPositionGoal,
    ctrGoal: positiveNumber(value.ctrGoal, "settings.ctrGoal") as number,
    cvrGoal: positiveNumber(value.cvrGoal, "settings.cvrGoal") as number,
    roasFloor: positiveNumber(value.roasFloor, "settings.roasFloor") as number,
  };
}

function withStatus(record: Omit<RppExperimentRecord, "status">, now: Date = new Date()): RppExperimentRecord {
  return { ...record, status: getRppExperimentStatus(record, now) };
}

function withoutStatus(record: RppExperimentRecord): Omit<RppExperimentRecord, "status"> {
  const stored = { ...record } as Partial<RppExperimentRecord>;
  delete stored.status;
  return stored as Omit<RppExperimentRecord, "status">;
}

async function ensureTable() {
  if (!pool) return;
  await pool.query(`
    create table if not exists ${TABLE} (
      id text primary key,
      target_id text not null,
      item_code text not null,
      keyword text not null,
      optimization_mode text not null,
      end_date text not null,
      started_at timestamptz not null,
      finished_at timestamptz,
      baseline jsonb not null,
      settings jsonb not null,
      result jsonb,
      note text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (target_id, started_at)
    )
  `);
  await pool.query(`create index if not exists ${TABLE}_target_started_idx on ${TABLE} (target_id, started_at desc)`);
}

type DbRow = {
  id: string;
  target_id: string;
  item_code: string;
  keyword: string;
  optimization_mode: RppExperimentMode;
  end_date: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  baseline: RppExperimentMetrics | string;
  settings: RppExperimentSettingsSnapshot | string;
  result: RppExperimentMetrics | string | null;
  note: string;
  created_at: Date | string;
  updated_at: Date | string;
};

function jsonValue<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function fromDb(row: DbRow, now = new Date()): RppExperimentRecord {
  return withStatus({
    id: row.id,
    targetId: row.target_id,
    itemCode: row.item_code,
    keyword: row.keyword,
    optimizationMode: row.optimization_mode,
    endDate: row.end_date,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : "",
    baseline: jsonValue(row.baseline),
    settings: jsonValue(row.settings),
    result: row.result ? jsonValue(row.result) : null,
    note: row.note || "",
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }, now);
}

async function readFallback(): Promise<RppExperimentRecord[]> {
  try {
    const raw = JSON.parse(await fs.readFile(historyPath(), "utf8")) as { experiments?: Omit<RppExperimentRecord, "status">[] } | Omit<RppExperimentRecord, "status">[];
    const records = Array.isArray(raw) ? raw : raw.experiments ?? [];
    return records.map((record) => withStatus(record));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeFallback(records: RppExperimentRecord[]) {
  const destination = historyPath();
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ experiments: records.map(withoutStatus) }, null, 2));
  await fs.rename(temporary, destination);
}

function mutateFallback<T>(operation: () => Promise<T>): Promise<T> {
  const result = fallbackQueue.then(operation, operation);
  fallbackQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function readRppExperimentHistory(options: { targetId?: string; now?: Date } = {}) {
  const now = options.now ?? new Date();
  if (pool) {
    await ensureTable();
    const params = options.targetId ? [options.targetId] : [];
    const where = options.targetId ? "where target_id = $1" : "";
    const result = await pool.query<DbRow>(`select * from ${TABLE} ${where} order by started_at desc, created_at desc`, params);
    return result.rows.map((row) => fromDb(row, now));
  }
  const records = await readFallback();
  return records
    .filter((record) => !options.targetId || record.targetId === options.targetId)
    .map((record) => ({ ...record, status: getRppExperimentStatus(record, now) }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.createdAt.localeCompare(a.createdAt));
}

export async function startRppExperiment(input: StartRppExperimentInput) {
  const targetId = text(input.targetId);
  const itemCode = text(input.itemCode).toLowerCase();
  const keyword = text(input.keyword);
  if (!targetId || !itemCode || !keyword) throw new Error("targetId、itemCode、keywordは必須です");
  if (input.optimizationMode !== "POSITION" && input.optimizationMode !== "FIXED") throw new Error("実験モードはPOSITIONまたはFIXEDを指定してください");
  const now = new Date().toISOString();
  const startedAt = input.startedAt ? timestamp(input.startedAt, "startedAt") : now;
  const record = withStatus({
    id: randomUUID(),
    targetId,
    itemCode,
    keyword,
    optimizationMode: input.optimizationMode,
    endDate: dateOnly(input.endDate, "endDate"),
    startedAt,
    finishedAt: "",
    baseline: normalizeMetrics(input.baseline, "baseline"),
    settings: normalizeSettings(input.settings),
    result: null,
    note: "",
    createdAt: now,
    updatedAt: now,
  });

  if (pool) {
    await ensureTable();
    const result = await pool.query<DbRow>(
      `insert into ${TABLE} (id, target_id, item_code, keyword, optimization_mode, end_date, started_at, baseline, settings, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)
       on conflict (target_id, started_at) do update set target_id = excluded.target_id
       returning *`,
      [record.id, record.targetId, record.itemCode, record.keyword, record.optimizationMode, record.endDate, record.startedAt, JSON.stringify(record.baseline), JSON.stringify(record.settings), record.createdAt, record.updatedAt],
    );
    return fromDb(result.rows[0]);
  }

  return mutateFallback(async () => {
    const records = await readFallback();
    const existing = records.find((row) => row.targetId === record.targetId && row.startedAt === record.startedAt);
    if (existing) return existing;
    records.push(record);
    await writeFallback(records);
    return record;
  });
}

export async function finishRppExperiment(id: string, input: FinishRppExperimentInput) {
  const experimentId = text(id);
  if (!experimentId) throw new Error("実験IDは必須です");
  const finishedAt = input.finishedAt ? timestamp(input.finishedAt, "finishedAt") : new Date().toISOString();
  const resultMetrics = normalizeMetrics(input.result, "result");
  const note = text(input.note);

  if (pool) {
    await ensureTable();
    const result = await pool.query<DbRow>(
      `update ${TABLE} set finished_at = $2, result = $3::jsonb, note = $4, updated_at = $2
       where id = $1 and finished_at is null returning *`,
      [experimentId, finishedAt, JSON.stringify(resultMetrics), note],
    );
    if (result.rows[0]) return fromDb(result.rows[0]);
    const found = await pool.query<{ finished_at: Date | string | null }>(`select finished_at from ${TABLE} where id = $1`, [experimentId]);
    if (!found.rows[0]) throw new Error(`実験履歴が見つかりません: ${experimentId}`);
    throw new Error(`実験はすでに終了しています: ${experimentId}`);
  }

  return mutateFallback(async () => {
    const records = await readFallback();
    const index = records.findIndex((row) => row.id === experimentId);
    if (index < 0) throw new Error(`実験履歴が見つかりません: ${experimentId}`);
    if (records[index].finishedAt) throw new Error(`実験はすでに終了しています: ${experimentId}`);
    const completed = withStatus({
      ...withoutStatus(records[index]),
      finishedAt,
      result: resultMetrics,
      note,
      updatedAt: finishedAt,
    });
    records[index] = completed;
    await writeFallback(records);
    return completed;
  });
}
