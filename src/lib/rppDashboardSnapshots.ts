import { pool } from "./db.ts";

export type RppSnapshotFile = {
  name: string;
  exists: boolean;
  mtime: string | null;
  size: number;
};

export type RppDashboardSnapshot = {
  syncedAt: string;
  recommendations: {
    summary: Record<string, unknown>;
    recommendations: Record<string, unknown>[];
  };
  latestFiles: RppSnapshotFile[];
  cronStatus?: Record<string, unknown> | null;
};

const TABLE = "rpp_dashboard_snapshots";

export function normalizeRppDashboardSnapshot(value: unknown): RppDashboardSnapshot {
  if (!value || typeof value !== "object") throw new Error("snapshot payload is required");
  const input = value as Partial<RppDashboardSnapshot>;
  if (!input.recommendations || typeof input.recommendations !== "object") throw new Error("recommendations is required");
  if (!Array.isArray(input.recommendations.recommendations)) throw new Error("recommendations.recommendations must be an array");
  if (!Array.isArray(input.latestFiles)) throw new Error("latestFiles must be an array");
  const syncedAt = typeof input.syncedAt === "string" && !Number.isNaN(new Date(input.syncedAt).getTime())
    ? new Date(input.syncedAt).toISOString()
    : new Date().toISOString();
  const latestFiles = input.latestFiles.map((file) => {
    if (!file || typeof file !== "object" || typeof file.name !== "string") throw new Error("latestFiles contains an invalid row");
    return {
      name: file.name,
      exists: file.exists === true,
      mtime: typeof file.mtime === "string" ? file.mtime : null,
      size: Number.isFinite(Number(file.size)) ? Number(file.size) : 0,
    };
  });
  return {
    syncedAt,
    recommendations: {
      summary: input.recommendations.summary && typeof input.recommendations.summary === "object" ? input.recommendations.summary : {},
      recommendations: input.recommendations.recommendations,
    },
    latestFiles,
    cronStatus: input.cronStatus && typeof input.cronStatus === "object" ? input.cronStatus : null,
  };
}

async function ensureTable() {
  if (!pool) return false;
  await pool.query(`
    create table if not exists ${TABLE} (
      id bigserial primary key,
      synced_at timestamptz not null,
      payload jsonb not null,
      created_at timestamptz not null default now()
    )
  `);
  await pool.query(`create index if not exists ${TABLE}_synced_at_idx on ${TABLE} (synced_at desc)`);
  return true;
}

export async function saveRppDashboardSnapshot(value: unknown) {
  const snapshot = normalizeRppDashboardSnapshot(value);
  if (!(await ensureTable()) || !pool) throw new Error("DATABASE_URL is not configured");
  await pool.query(`insert into ${TABLE} (synced_at, payload) values ($1, $2::jsonb)`, [snapshot.syncedAt, JSON.stringify(snapshot)]);
  await pool.query(`delete from ${TABLE} where id not in (select id from ${TABLE} order by synced_at desc, id desc limit 45)`);
  return snapshot;
}

export async function readLatestRppDashboardSnapshot() {
  if (!(await ensureTable()) || !pool) return null;
  const result = await pool.query<{ payload: RppDashboardSnapshot }>(`select payload from ${TABLE} order by synced_at desc, id desc limit 1`);
  return result.rows[0]?.payload ? normalizeRppDashboardSnapshot(result.rows[0].payload) : null;
}
