import type { Pool, PoolClient } from "pg";
import { pool } from "./db.ts";

export type RppSnapshotFile = { name: string; exists: boolean; mtime: string | null; size: number };
export type RppPerformanceDailyRow = { itemCode: string; ctr: number | null; clicks: number; spend: number; sales12h: number; orders12h: number; sales720h: number; orders720h: number };
export type RppPerformanceDaily = { source: string; sourceMtime: string; date: string; attribution: { sales12h: true; sales720h: true }; rows: RppPerformanceDailyRow[] };
export type RppSnapshotConfiguredTarget = { id: string; itemCode: string; itemName: string; keyword: string; itemCpc: number | null; keywordCpc: number | null; source: "商品CPC" | "キーワードCPC"; owner?: string; rppPosition?: string; rppPositionKeyword?: string; rppPositions?: { keyword: string; position: string }[] };
export type RppSnapshotExclusionProduct = { itemCode: string; itemName: string; itemCpc: number | null; excluded: boolean; owner?: string };
export type RppSnapshotOperationalData = { configuredTargets: RppSnapshotConfiguredTarget[]; exclusionProducts: RppSnapshotExclusionProduct[]; owners: string[] };
export type RppDashboardSnapshot = {
  schemaVersion: 1 | 2 | 3;
  syncedAt: string;
  recommendations: { summary: Record<string, unknown>; recommendations: Record<string, unknown>[] };
  latestFiles: RppSnapshotFile[];
  cronStatus?: Record<string, unknown> | null;
  performanceDaily?: RppPerformanceDaily | null;
  rppData?: RppSnapshotOperationalData | null;
};
const TABLE = "rpp_dashboard_snapshots";
const PERFORMANCE_TABLE = "rpp_performance_daily";
const num = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const dateOnly = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";

function normalizePerformanceDaily(value: unknown): RppPerformanceDaily | null {
  if (value == null) return null;
  if (!value || typeof value !== "object") throw new Error("performanceDaily must be an object");
  const input = value as Partial<RppPerformanceDaily>;
  const date = dateOnly(input.date);
  if (!date) throw new Error("performanceDaily.date must be YYYY-MM-DD");
  if (typeof input.source !== "string" || typeof input.sourceMtime !== "string" || Number.isNaN(new Date(input.sourceMtime).getTime())) throw new Error("performanceDaily source metadata is invalid");
  if (!Array.isArray(input.rows)) throw new Error("performanceDaily.rows must be an array");
  const rows = input.rows.map((raw) => {
    const itemCode = String(raw?.itemCode ?? "").trim().toLowerCase();
    if (!itemCode) throw new Error("performanceDaily row itemCode is required");
    return { itemCode, ctr: raw.ctr == null ? null : num(raw.ctr), clicks: Math.round(num(raw.clicks)), spend: num(raw.spend), sales12h: num(raw.sales12h), orders12h: Math.round(num(raw.orders12h)), sales720h: num(raw.sales720h), orders720h: Math.round(num(raw.orders720h)) };
  });
  return { source: input.source, sourceMtime: new Date(input.sourceMtime).toISOString(), date, attribution: { sales12h: true, sales720h: true }, rows };
}

function nullablePositiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeOperationalData(value: unknown): RppSnapshotOperationalData | null {
  if (value == null) return null;
  if (!value || typeof value !== "object") throw new Error("rppData must be an object");
  const input = value as Partial<RppSnapshotOperationalData>;
  if (!Array.isArray(input.configuredTargets) || !Array.isArray(input.exclusionProducts) || !Array.isArray(input.owners)) throw new Error("rppData arrays are required");
  const configuredTargets = input.configuredTargets.map((raw) => {
    const itemCode = String(raw?.itemCode ?? "").trim().toLowerCase();
    const keyword = String(raw?.keyword ?? "").trim();
    const source: RppSnapshotConfiguredTarget["source"] | null = raw?.source === "キーワードCPC" ? "キーワードCPC" : raw?.source === "商品CPC" ? "商品CPC" : null;
    if (!itemCode || !keyword || !source) throw new Error("rppData configured target is invalid");
    return { id: String(raw.id ?? "").trim(), itemCode, itemName: String(raw.itemName ?? "").trim(), keyword, itemCpc: nullablePositiveNumber(raw.itemCpc), keywordCpc: nullablePositiveNumber(raw.keywordCpc), source, owner: String(raw.owner ?? "").trim() || "担当未設定" };
  });
  const exclusionProducts = input.exclusionProducts.map((raw) => {
    const itemCode = String(raw?.itemCode ?? "").trim().toLowerCase();
    if (!itemCode) throw new Error("rppData exclusion product itemCode is required");
    return { itemCode, itemName: String(raw.itemName ?? "").trim(), itemCpc: nullablePositiveNumber(raw.itemCpc), excluded: raw.excluded === true, owner: String(raw.owner ?? "").trim() || "担当未設定" };
  });
  const owners = [...new Set(input.owners.map((owner) => String(owner ?? "").trim()).filter((owner) => owner && owner !== "なし"))];
  return { configuredTargets, exclusionProducts, owners };
}

export function normalizeRppDashboardSnapshot(value: unknown): RppDashboardSnapshot {
  if (!value || typeof value !== "object") throw new Error("snapshot payload is required");
  const input = value as Partial<RppDashboardSnapshot>;
  if (!input.recommendations || typeof input.recommendations !== "object") throw new Error("recommendations is required");
  if (!Array.isArray(input.recommendations.recommendations)) throw new Error("recommendations.recommendations must be an array");
  if (!Array.isArray(input.latestFiles)) throw new Error("latestFiles must be an array");
  const syncedAt = typeof input.syncedAt === "string" && !Number.isNaN(new Date(input.syncedAt).getTime()) ? new Date(input.syncedAt).toISOString() : new Date().toISOString();
  const latestFiles = input.latestFiles.map((file) => {
    if (!file || typeof file !== "object" || typeof file.name !== "string") throw new Error("latestFiles contains an invalid row");
    return { name: file.name, exists: file.exists === true, mtime: typeof file.mtime === "string" ? file.mtime : null, size: Number.isFinite(Number(file.size)) ? Number(file.size) : 0 };
  });
  const performanceDaily = normalizePerformanceDaily(input.performanceDaily);
  const rppData = normalizeOperationalData(input.rppData);
  return { schemaVersion: rppData ? 3 : performanceDaily ? 2 : 1, syncedAt, recommendations: { summary: input.recommendations.summary && typeof input.recommendations.summary === "object" ? input.recommendations.summary : {}, recommendations: input.recommendations.recommendations }, latestFiles, cronStatus: input.cronStatus && typeof input.cronStatus === "object" ? input.cronStatus : null, performanceDaily, rppData };
}

async function ensureTables(client: Pool | PoolClient | null = pool) {
  if (!client) return false;
  await client.query(`create table if not exists ${TABLE} (id bigserial primary key,synced_at timestamptz not null,payload jsonb not null,created_at timestamptz not null default now())`);
  await client.query(`create index if not exists ${TABLE}_synced_at_idx on ${TABLE} (synced_at desc)`);
  await client.query(`create table if not exists ${PERFORMANCE_TABLE} (performance_date date not null,item_code text not null,clicks integer not null,spend numeric(14,2) not null,ctr numeric(10,4),sales_12h numeric(14,2) not null,orders_12h integer not null,sales_720h numeric(14,2) not null,orders_720h integer not null,source_file text not null,source_mtime timestamptz not null,observed_at timestamptz not null,primary key(performance_date,item_code))`);
  await client.query(`create index if not exists ${PERFORMANCE_TABLE}_date_idx on ${PERFORMANCE_TABLE}(performance_date desc)`);
  return true;
}

export async function saveRppDashboardSnapshot(value: unknown) {
  const snapshot = normalizeRppDashboardSnapshot(value);
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await ensureTables(client);
    await client.query(`insert into ${TABLE} (synced_at,payload) values($1,$2::jsonb)`, [snapshot.syncedAt, JSON.stringify(snapshot)]);
    for (const row of snapshot.performanceDaily?.rows ?? []) {
      await client.query(`insert into ${PERFORMANCE_TABLE}(performance_date,item_code,clicks,spend,ctr,sales_12h,orders_12h,sales_720h,orders_720h,source_file,source_mtime,observed_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(performance_date,item_code) do update set clicks=excluded.clicks,spend=excluded.spend,ctr=excluded.ctr,sales_12h=excluded.sales_12h,orders_12h=excluded.orders_12h,sales_720h=excluded.sales_720h,orders_720h=excluded.orders_720h,source_file=excluded.source_file,source_mtime=excluded.source_mtime,observed_at=excluded.observed_at where excluded.source_mtime >= ${PERFORMANCE_TABLE}.source_mtime or excluded.observed_at > ${PERFORMANCE_TABLE}.observed_at`, [snapshot.performanceDaily!.date,row.itemCode,row.clicks,row.spend,row.ctr,row.sales12h,row.orders12h,row.sales720h,row.orders720h,snapshot.performanceDaily!.source,snapshot.performanceDaily!.sourceMtime,snapshot.syncedAt]);
    }
    await client.query(`delete from ${TABLE} where id not in (select id from ${TABLE} order by synced_at desc,id desc limit 90)`);
    await client.query(`delete from ${PERFORMANCE_TABLE} where performance_date < current_date - interval '800 days'`);
    await client.query("commit");
    return snapshot;
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}

export async function readRecentRppDashboardSnapshots(limit = 2) {
  if (!(await ensureTables()) || !pool) return [];
  const safeLimit = Math.max(1, Math.min(10, Math.round(limit)));
  const result = await pool.query<{ payload: RppDashboardSnapshot }>(`select payload from ${TABLE} order by synced_at desc,id desc limit $1`, [safeLimit]);
  return result.rows.flatMap((row) => row.payload ? [normalizeRppDashboardSnapshot(row.payload)] : []);
}

export async function readLatestRppDashboardSnapshot() {
  return (await readRecentRppDashboardSnapshots(1))[0] ?? null;
}
