import { Pool, type QueryResultRow } from "pg";

const connectionString = process.env.DATABASE_URL;

declare global {
  var rakutenMvpPool: Pool | undefined;
}

export const pool = connectionString
  ? (globalThis.rakutenMvpPool ??
      new Pool({
        connectionString,
        max: 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      }))
  : null;

if (process.env.NODE_ENV !== "production" && pool) {
  globalThis.rakutenMvpPool = pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
  if (!pool) return [] as T[];
  const result = await pool.query<T>(sql, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}
