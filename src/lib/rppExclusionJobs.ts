import { promises as fs } from "fs";
import path from "path";
import { pool } from "@/lib/db";

export type RppExclusionJobChange = { itemCode: string; currentExcluded: boolean; originalExcluded?: boolean };
export type RppExclusionJob = {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  changes: RppExclusionJobChange[];
  csvContent: string;
  csvPath: string | null;
  error: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
};

const DEFAULT_RPP_PROJECT_DIR = "/Users/nob/Projects/rpp-8am-notify";
const RPP_PROJECT_DIR = process.env.RPP_PROJECT_DIR ?? (process.platform === "darwin" ? DEFAULT_RPP_PROJECT_DIR : "/var/data/rpp-8am-notify");
const DATA_DIR = path.join(RPP_PROJECT_DIR, "rpp_targets");
const JOBS_PATH = path.join(DATA_DIR, "rpp_exclusion_jobs.json");
const OVERRIDES_PATH = path.join(DATA_DIR, "rpp_exclusion_overrides.json");
const JOBS_TABLE = "rpp_exclusion_jobs";
const OVERRIDES_TABLE = "rpp_exclusion_overrides";

function now() { return new Date().toISOString(); }
function csvCell(value: string) { return `"${String(value).replaceAll('"', '""')}"`; }
export function buildExclusionCsv(changes: RppExclusionJobChange[]) {
  const lines = [
    '"コントロールカラム","商品管理番号"',
    ...changes.map((row) => `${csvCell(row.currentExcluded ? "n" : "d")},${csvCell(row.itemCode)}`),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

async function ensureTables() {
  if (!pool) return;
  await pool.query(`create table if not exists ${JOBS_TABLE} (
    id text primary key,
    status text not null default 'pending',
    changes jsonb not null,
    csv_content text not null,
    csv_path text,
    error text,
    result jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`);
  await pool.query(`create table if not exists ${OVERRIDES_TABLE} (
    item_code text primary key,
    excluded boolean not null,
    updated_at timestamptz not null default now(),
    job_id text
  )`);
}

async function readFileJobs(): Promise<RppExclusionJob[]> {
  try {
    const raw = JSON.parse(await fs.readFile(JOBS_PATH, "utf8")) as { jobs?: RppExclusionJob[] } | RppExclusionJob[];
    return Array.isArray(raw) ? raw : raw.jobs ?? [];
  } catch { return []; }
}
async function writeFileJobs(jobs: RppExclusionJob[]) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(JOBS_PATH, JSON.stringify({ updatedAt: now(), jobs }, null, 2));
}

export async function createRppExclusionJob(changes: RppExclusionJobChange[]) {
  const clean = changes.filter((row) => row.itemCode && row.currentExcluded !== row.originalExcluded)
    .map((row) => ({ itemCode: row.itemCode.trim().toLowerCase(), currentExcluded: row.currentExcluded, originalExcluded: row.originalExcluded }));
  if (!clean.length) throw new Error("変更対象がありません");
  const id = `rpp_excl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const csvContent = buildExclusionCsv(clean);
  const job: RppExclusionJob = { id, status: "pending", changes: clean, csvContent, csvPath: null, error: null, result: null, createdAt: now(), updatedAt: now() };
  await ensureTables();
  if (pool) {
    await pool.query(
      `insert into ${JOBS_TABLE} (id, status, changes, csv_content, created_at, updated_at) values ($1,'pending',$2::jsonb,$3,$4,$4)`,
      [job.id, JSON.stringify(job.changes), job.csvContent, job.createdAt]
    );
  } else {
    const jobs = await readFileJobs(); jobs.push(job); await writeFileJobs(jobs);
  }
  return job;
}

function mapJob(row: Record<string, unknown>): RppExclusionJob {
  return {
    id: String(row.id),
    status: row.status as RppExclusionJob["status"],
    changes: row.changes as RppExclusionJobChange[],
    csvContent: String(row.csv_content ?? row.csvContent ?? ""),
    csvPath: row.csv_path ? String(row.csv_path) : row.csvPath ? String(row.csvPath) : null,
    error: row.error ? String(row.error) : null,
    result: row.result ?? null,
    createdAt: new Date(String(row.created_at ?? row.createdAt)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.updatedAt)).toISOString(),
  };
}

export async function claimNextRppExclusionJob() {
  await ensureTables();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const found = await client.query(`select * from ${JOBS_TABLE} where status='pending' order by created_at asc limit 1 for update skip locked`);
      if (!found.rows[0]) { await client.query("commit"); return null; }
      await client.query(`update ${JOBS_TABLE} set status='running', updated_at=now() where id=$1`, [found.rows[0].id]);
      await client.query("commit");
      return { ...mapJob(found.rows[0]), status: "running" as const };
    } catch (e) { await client.query("rollback"); throw e; }
    finally { client.release(); }
  }
  const jobs = await readFileJobs();
  const idx = jobs.findIndex((job) => job.status === "pending");
  if (idx < 0) return null;
  jobs[idx] = { ...jobs[idx], status: "running", updatedAt: now() };
  await writeFileJobs(jobs);
  return jobs[idx];
}

export async function completeRppExclusionJob(id: string, ok: boolean, payload: { csvPath?: string; error?: string; result?: unknown }) {
  await ensureTables();
  if (pool) {
    await pool.query(`update ${JOBS_TABLE} set status=$2, csv_path=$3, error=$4, result=$5::jsonb, updated_at=now() where id=$1`, [id, ok ? "succeeded" : "failed", payload.csvPath ?? null, payload.error ?? null, JSON.stringify(payload.result ?? null)]);
    if (ok) {
      const job = await pool.query(`select changes from ${JOBS_TABLE} where id=$1`, [id]);
      for (const row of (job.rows[0]?.changes ?? []) as RppExclusionJobChange[]) {
        await pool.query(`insert into ${OVERRIDES_TABLE} (item_code, excluded, updated_at, job_id) values ($1,$2,now(),$3) on conflict (item_code) do update set excluded=excluded.excluded, updated_at=now(), job_id=excluded.job_id`, [row.itemCode.trim().toLowerCase(), row.currentExcluded, id]);
      }
    }
    return;
  }
  const jobs = await readFileJobs();
  const idx = jobs.findIndex((job) => job.id === id);
  if (idx >= 0) { jobs[idx] = { ...jobs[idx], status: ok ? "succeeded" : "failed", csvPath: payload.csvPath ?? null, error: payload.error ?? null, result: payload.result ?? null, updatedAt: now() }; await writeFileJobs(jobs); }
  if (ok && idx >= 0) await writeExclusionOverrides(jobs[idx].changes, id);
}

async function writeExclusionOverrides(changes: RppExclusionJobChange[], jobId: string) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const current = await readRppExclusionOverrides();
  for (const row of changes) current[row.itemCode.trim().toLowerCase()] = row.currentExcluded;
  await fs.writeFile(OVERRIDES_PATH, JSON.stringify({ updatedAt: now(), jobId, products: current }, null, 2));
}

export async function readRppExclusionOverrides(): Promise<Record<string, boolean>> {
  await ensureTables();
  if (pool) {
    const rows = await pool.query<{ item_code: string; excluded: boolean }>(`select item_code, excluded from ${OVERRIDES_TABLE}`);
    return Object.fromEntries(rows.rows.map((row) => [row.item_code.trim().toLowerCase(), row.excluded]));
  }
  try {
    const raw = JSON.parse(await fs.readFile(OVERRIDES_PATH, "utf8")) as { products?: Record<string, boolean> } | Record<string, boolean>;
    const products = "products" in raw ? raw.products ?? {} : raw;
    return Object.fromEntries(Object.entries(products).map(([code, excluded]) => [code.trim().toLowerCase(), Boolean(excluded)]));
  } catch { return {}; }
}

export async function listRecentRppExclusionJobs(limit = 20) {
  await ensureTables();
  if (pool) {
    const rows = await pool.query(`select * from ${JOBS_TABLE} order by created_at desc limit $1`, [limit]);
    return rows.rows.map(mapJob);
  }
  return (await readFileJobs()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}
