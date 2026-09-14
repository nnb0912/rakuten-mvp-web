import type { Pool, PoolClient } from "pg";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { pool } from "./db.ts";

export type RppSnapshotFile = { name: string; exists: boolean; mtime: string | null; size: number };
export type RppPerformanceDailyRow = { itemCode: string; ctr: number | null; clicks: number; spend: number; sales12h: number; orders12h: number; sales720h: number; orders720h: number };
export type RppPerformanceReceipt = { version: 1; file: string; completedAt: string; sha256: string; actualCount: number; requestStartedAt: string; historyCreatedAt: string; historyRowSha256: string; sourceArchiveSha256: string; sourceArchiveBytes: number; sourceCsvCrc32: string; sourceCsvCompressedBytes: number; sourceCsvUncompressedBytes: number; sourceCsvNameSha256: string; source: string; sourceMtime: string; rowsSha256: string; signature: string; complete: true };
export type RppPerformanceDaily = { source: string; sourceMtime: string; date: string; attribution: { sales12h: true; sales720h: true }; rows: RppPerformanceDailyRow[]; receipt: RppPerformanceReceipt };
export type RppSnapshotConfiguredTarget = { id: string; itemCode: string; itemName: string; keyword: string; itemCpc: number | null; keywordCpc: number | null; source: "商品CPC" | "キーワードCPC"; owner?: string; rppPosition?: string; rppPositionKeyword?: string; rppPositions?: { keyword: string; position: string }[] };
export type RppSnapshotExclusionProduct = { itemCode: string; itemName: string; itemCpc: number | null; excluded: boolean; owner?: string };
export type RppExclusionObservation = { observedAt: string; expectedCount: number; actualCount: number; complete: boolean };
export type RppSnapshotOperationalData = { configuredTargets: RppSnapshotConfiguredTarget[]; allConfiguredTargets?: RppSnapshotConfiguredTarget[]; exclusionProducts: RppSnapshotExclusionProduct[]; exclusionObservation?: RppExclusionObservation; owners: string[] };
export type RppDashboardSnapshot = {
  schemaVersion: 1 | 2 | 3 | 4;
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

function performanceRowsSha256(rows: RppPerformanceDailyRow[]) {
  const body = [...rows].sort((a, b) => a.itemCode.localeCompare(b.itemCode)).map((row) => [row.itemCode, row.ctr, row.clicks, row.spend, row.sales12h, row.orders12h, row.sales720h, row.orders720h].map((value, index) => index === 0 ? String(value) : Number(value).toFixed(6)).join("\t")).join("\n");
  return createHash("sha256").update(body).digest("hex");
}

function validPerformanceReceiptSignature(receipt: Partial<RppPerformanceReceipt>, date: string, source: string, sourceMtime: string, rows: RppPerformanceDailyRow[]) {
  const key = process.env.RPP_PERFORMANCE_RECEIPT_HMAC_KEY ?? "";
  const signature = String(receipt.signature ?? "");
  if (key.length < 32 || !/^[a-f0-9]{64}$/.test(signature)) return false;
  if (receipt.source !== source || receipt.sourceMtime !== sourceMtime || receipt.rowsSha256 !== performanceRowsSha256(rows)) return false;
  const message = [receipt.version, receipt.sha256, date, date, receipt.actualCount, receipt.requestStartedAt, receipt.historyCreatedAt, receipt.historyRowSha256, receipt.sourceArchiveSha256, receipt.sourceArchiveBytes, receipt.sourceCsvCrc32, receipt.sourceCsvCompressedBytes, receipt.sourceCsvUncompressedBytes, receipt.sourceCsvNameSha256, receipt.source, receipt.sourceMtime, receipt.completedAt, receipt.rowsSha256].map((value) => String(value ?? "")).join("\n");
  const expected = createHmac("sha256", key).update(message).digest("hex");
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

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
  const receipt = input.receipt as Partial<RppPerformanceReceipt> | undefined;
  const completedAt = typeof receipt?.completedAt === "string" ? new Date(receipt.completedAt) : new Date(NaN);
  const sourceMtime = new Date(input.sourceMtime).toISOString();
  const requestAt = new Date(String(receipt?.requestStartedAt ?? ""));
  const historyAt = new Date(String(receipt?.historyCreatedAt ?? "").replace(" ", "T") + "+09:00");
  const evidenceHashesValid = /^[a-f0-9]{64}$/.test(String(receipt?.historyRowSha256 ?? "")) && /^[a-f0-9]{64}$/.test(String(receipt?.sourceArchiveSha256 ?? "")) && /^[a-f0-9]{64}$/.test(String(receipt?.sourceCsvNameSha256 ?? ""));
  const providerManifestValid = Number.isInteger(receipt?.sourceArchiveBytes) && Number(receipt?.sourceArchiveBytes) > 0 && Number.isInteger(receipt?.sourceCsvCompressedBytes) && Number(receipt?.sourceCsvCompressedBytes) > 0 && Number.isInteger(receipt?.sourceCsvUncompressedBytes) && Number(receipt?.sourceCsvUncompressedBytes) > 0 && /^[a-f0-9]{8}$/.test(String(receipt?.sourceCsvCrc32 ?? ""));
  const timesValid = !Number.isNaN(requestAt.getTime()) && !Number.isNaN(historyAt.getTime()) && !Number.isNaN(completedAt.getTime()) && historyAt.getTime() >= requestAt.getTime() - 5_000 && historyAt.getTime() <= completedAt.getTime() && new Date(sourceMtime).getTime() >= requestAt.getTime() - 5_000 && new Date(sourceMtime).getTime() <= completedAt.getTime() + 5_000 && completedAt.getTime() >= requestAt.getTime() && completedAt.getTime() - requestAt.getTime() <= 30 * 60_000 && completedAt.getTime() <= Date.now() + 5 * 60_000 && requestAt.getTime() <= Date.now() + 5 * 60_000;
  if (!receipt || receipt.version !== 1 || receipt.complete !== true || !/^[a-f0-9]{64}$/.test(String(receipt.sha256 ?? "")) || receipt.actualCount !== rows.length || !String(receipt.file ?? "").trim() || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(receipt.historyCreatedAt ?? "")) || !evidenceHashesValid || !providerManifestValid || !timesValid || !validPerformanceReceiptSignature(receipt, date, String(input.source), sourceMtime, rows)) throw new Error("performanceDaily verified receipt is invalid");
  return { source: String(input.source), sourceMtime, date, attribution: { sales12h: true, sales720h: true }, rows, receipt: { ...receipt, completedAt: completedAt.toISOString() } as RppPerformanceReceipt };
}

function nullablePositiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeConfiguredTargets(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((raw: Partial<RppSnapshotConfiguredTarget>) => {
    const itemCode = String(raw?.itemCode ?? "").trim().toLowerCase();
    const keyword = String(raw?.keyword ?? "").trim();
    const source: RppSnapshotConfiguredTarget["source"] | null = raw?.source === "キーワードCPC" ? "キーワードCPC" : raw?.source === "商品CPC" ? "商品CPC" : null;
    if (!itemCode || !keyword || !source) throw new Error(`${field} row is invalid`);
    const rppPositions = Array.isArray(raw.rppPositions)
      ? raw.rppPositions.flatMap((position) => {
          const basisKeyword = String(position?.keyword ?? "").trim();
          const value = String(position?.position ?? "").trim();
          return basisKeyword && value ? [{ keyword: basisKeyword, position: value }] : [];
        })
      : undefined;
    return {
      id: String(raw.id ?? "").trim(), itemCode, itemName: String(raw.itemName ?? "").trim(), keyword,
      itemCpc: nullablePositiveNumber(raw.itemCpc), keywordCpc: nullablePositiveNumber(raw.keywordCpc),
      source, owner: String(raw.owner ?? "").trim() || "担当未設定",
      rppPosition: String(raw.rppPosition ?? "").trim() || undefined,
      rppPositionKeyword: String(raw.rppPositionKeyword ?? "").trim() || undefined,
      rppPositions,
    };
  });
}

function normalizeOperationalData(value: unknown): RppSnapshotOperationalData | null {
  if (value == null) return null;
  if (!value || typeof value !== "object") throw new Error("rppData must be an object");
  const input = value as Partial<RppSnapshotOperationalData>;
  if (!Array.isArray(input.configuredTargets) || !Array.isArray(input.exclusionProducts) || !Array.isArray(input.owners)) throw new Error("rppData arrays are required");
  const configuredTargets = normalizeConfiguredTargets(input.configuredTargets, "rppData.configuredTargets");
  const allConfiguredTargets = input.allConfiguredTargets == null ? undefined : normalizeConfiguredTargets(input.allConfiguredTargets, "rppData.allConfiguredTargets");
  const exclusionProducts = input.exclusionProducts.map((raw) => {
    const itemCode = String(raw?.itemCode ?? "").trim().toLowerCase();
    if (!itemCode) throw new Error("rppData exclusion product itemCode is required");
    return { itemCode, itemName: String(raw.itemName ?? "").trim(), itemCpc: nullablePositiveNumber(raw.itemCpc), excluded: raw.excluded === true, owner: String(raw.owner ?? "").trim() || "担当未設定" };
  });
  const owners = [...new Set(input.owners.map((owner) => String(owner ?? "").trim()).filter((owner) => owner && owner !== "なし"))];
  let exclusionObservation: RppExclusionObservation | undefined;
  if (input.exclusionObservation != null) {
    const raw = input.exclusionObservation;
    const observedAt = typeof raw.observedAt === "string" ? new Date(raw.observedAt) : new Date(NaN);
    const expectedCount = Number(raw.expectedCount);
    const actualCount = Number(raw.actualCount);
    if (Number.isNaN(observedAt.getTime()) || !Number.isInteger(expectedCount) || expectedCount < 0 || !Number.isInteger(actualCount) || actualCount < 0) throw new Error("rppData exclusion observation is invalid");
    exclusionObservation = { observedAt: observedAt.toISOString(), expectedCount, actualCount, complete: raw.complete === true && expectedCount === actualCount };
  }
  return { configuredTargets, allConfiguredTargets, exclusionProducts, exclusionObservation, owners };
}

function normalizeRecommendationRows(value: unknown) {
  if (!Array.isArray(value)) throw new Error("recommendations.recommendations must be an array");
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`recommendation row ${index} must be an object`);
    const row = raw as Record<string, unknown>;
    const action = row.action;
    if (!String(row.itemCode ?? "").trim() || !String(row.keyword ?? "").trim()) throw new Error(`recommendation row ${index} identifiers are required`);
    if (!["RAISE", "LOWER", "HOLD"].includes(String(action))) throw new Error(`recommendation row ${index} action is invalid`);
    if (!Array.isArray(row.reasons) || !Array.isArray(row.blocks) || typeof row.uploadReady !== "boolean") throw new Error(`recommendation row ${index} safety fields are invalid`);
    if (action === "RAISE" || action === "LOWER") {
      if (!(Number.isFinite(Number(row.currentCpc)) && Number(row.currentCpc) > 0 && Number.isFinite(Number(row.proposedCpc)) && Number(row.proposedCpc) > 0 && String(row.source ?? "").trim())) throw new Error(`recommendation row ${index} actionable CPC fields are invalid`);
    }
    return row;
  });
}

export function normalizeRppDashboardSnapshot(value: unknown): RppDashboardSnapshot {
  if (!value || typeof value !== "object") throw new Error("snapshot payload is required");
  const input = value as Partial<RppDashboardSnapshot>;
  if (!input.recommendations || typeof input.recommendations !== "object") throw new Error("recommendations is required");
  const recommendationRows = normalizeRecommendationRows(input.recommendations.recommendations);
  if (!Array.isArray(input.latestFiles)) throw new Error("latestFiles must be an array");
  if (typeof input.syncedAt !== "string" || Number.isNaN(new Date(input.syncedAt).getTime())) throw new Error("syncedAt must be a valid timestamp");
  const syncedAt = new Date(input.syncedAt).toISOString();
  const latestFiles = input.latestFiles.map((file) => {
    if (!file || typeof file !== "object" || typeof file.name !== "string") throw new Error("latestFiles contains an invalid row");
    return { name: file.name, exists: file.exists === true, mtime: typeof file.mtime === "string" ? file.mtime : null, size: Number.isFinite(Number(file.size)) ? Number(file.size) : 0 };
  });
  const performanceDaily = normalizePerformanceDaily(input.performanceDaily);
  const rppData = normalizeOperationalData(input.rppData);
  return { schemaVersion: rppData?.allConfiguredTargets ? 4 : rppData ? 3 : performanceDaily ? 2 : 1, syncedAt, recommendations: { summary: input.recommendations.summary && typeof input.recommendations.summary === "object" ? input.recommendations.summary : {}, recommendations: recommendationRows }, latestFiles, cronStatus: input.cronStatus && typeof input.cronStatus === "object" ? input.cronStatus : null, performanceDaily, rppData };
}

async function ensureTables(client: Pool | PoolClient | null = pool) {
  if (!client) return false;
  await client.query(`create table if not exists ${TABLE} (id bigserial primary key,synced_at timestamptz not null,payload jsonb not null,created_at timestamptz not null default now())`);
  await client.query(`create index if not exists ${TABLE}_synced_at_idx on ${TABLE} (synced_at desc)`);
  await client.query(`create table if not exists ${PERFORMANCE_TABLE} (performance_date date not null,item_code text not null,clicks integer not null,spend numeric(14,2) not null,ctr numeric(10,4),sales_12h numeric(14,2) not null,orders_12h integer not null,sales_720h numeric(14,2) not null,orders_720h integer not null,source_file text not null,source_mtime timestamptz not null,observed_at timestamptz not null,primary key(performance_date,item_code))`);
  await client.query(`create index if not exists ${PERFORMANCE_TABLE}_date_idx on ${PERFORMANCE_TABLE}(performance_date desc)`);
  return true;
}

async function queryRppPerformanceDaily(client: Pool | PoolClient, date: string) {
  const result = await client.query(`select item_code,clicks,spend,ctr,sales_12h,orders_12h,sales_720h,orders_720h,source_file,source_mtime from ${PERFORMANCE_TABLE} where performance_date=$1 and source_mtime=(select max(source_mtime) from ${PERFORMANCE_TABLE} where performance_date=$1) order by item_code`, [date]);
  return result.rows.map((row) => ({
    itemCode: String(row.item_code), clicks: Number(row.clicks), spend: Number(row.spend), ctr: row.ctr == null ? null : Number(row.ctr),
    sales12h: Number(row.sales_12h), orders12h: Number(row.orders_12h), sales720h: Number(row.sales_720h), orders720h: Number(row.orders_720h),
    source: String(row.source_file), sourceMtime: new Date(row.source_mtime).toISOString(),
  }));
}

function assertPersistedPerformanceMatches(performance: RppPerformanceDaily, actualRows: Awaited<ReturnType<typeof queryRppPerformanceDaily>>) {
  const expected = [...performance.rows].sort((a, b) => a.itemCode.localeCompare(b.itemCode));
  if (actualRows.length !== expected.length) throw new Error("performance daily persistence row count mismatch");
  const fields: Array<keyof RppPerformanceDailyRow> = ["clicks", "spend", "ctr", "sales12h", "orders12h", "sales720h", "orders720h"];
  expected.forEach((row, index) => {
    const actual = actualRows[index];
    if (actual.itemCode !== row.itemCode) throw new Error("performance daily persistence item mismatch");
    for (const field of fields) {
      if (actual[field] !== row[field]) throw new Error(`performance daily persistence ${field} mismatch`);
    }
    if (actual.source !== performance.source || actual.sourceMtime !== performance.sourceMtime) throw new Error("performance daily persistence source mismatch");
  });
}

export async function saveRppDashboardSnapshot(value: unknown) {
  const snapshot = normalizeRppDashboardSnapshot(value);
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await ensureTables(client);
    if (snapshot.performanceDaily) {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", ["rpp-performance-global"]);
      const latestDate = await client.query(`select max(performance_date)::text as performance_date from ${PERFORMANCE_TABLE}`);
      if (latestDate.rows[0]?.performance_date && snapshot.performanceDaily.date < String(latestDate.rows[0].performance_date)) throw new Error("performance daily date is older than latest persisted date");
      const latest = await client.query(`select max(source_mtime) as source_mtime from ${PERFORMANCE_TABLE} where performance_date=$1`, [snapshot.performanceDaily.date]);
      const currentSourceMtime = latest.rows[0]?.source_mtime == null ? null : new Date(latest.rows[0].source_mtime);
      if (currentSourceMtime && new Date(snapshot.performanceDaily.sourceMtime) < currentSourceMtime) throw new Error("performance daily source is older than persisted data");
    }
    for (const row of snapshot.performanceDaily?.rows ?? []) {
      await client.query(`insert into ${PERFORMANCE_TABLE}(performance_date,item_code,clicks,spend,ctr,sales_12h,orders_12h,sales_720h,orders_720h,source_file,source_mtime,observed_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(performance_date,item_code) do update set clicks=excluded.clicks,spend=excluded.spend,ctr=excluded.ctr,sales_12h=excluded.sales_12h,orders_12h=excluded.orders_12h,sales_720h=excluded.sales_720h,orders_720h=excluded.orders_720h,source_file=excluded.source_file,source_mtime=excluded.source_mtime,observed_at=excluded.observed_at where excluded.source_mtime > ${PERFORMANCE_TABLE}.source_mtime`, [snapshot.performanceDaily!.date,row.itemCode,row.clicks,row.spend,row.ctr,row.sales12h,row.orders12h,row.sales720h,row.orders720h,snapshot.performanceDaily!.source,snapshot.performanceDaily!.sourceMtime,snapshot.syncedAt]);
    }
    if (snapshot.performanceDaily) assertPersistedPerformanceMatches(snapshot.performanceDaily, await queryRppPerformanceDaily(client, snapshot.performanceDaily.date));
    await client.query(`insert into ${TABLE} (synced_at,payload) values($1,$2::jsonb)`, [snapshot.syncedAt, JSON.stringify(snapshot)]);
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

export async function readRppPerformanceDaily(date: string) {
  if (!dateOnly(date)) throw new Error("performance date must be YYYY-MM-DD");
  if (!(await ensureTables()) || !pool) return [];
  return queryRppPerformanceDaily(pool, date);
}
