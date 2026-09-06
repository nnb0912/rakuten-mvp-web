import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pool } from "./db.ts";

export type RppEditActor = { email: string; name: string };
export type RppEditLock = {
  itemCode: string;
  actorName: string;
  expiresAt: string;
  updatedAt: string;
};
type StoredRppEditLock = RppEditLock & { actorEmail: string; token: string };
export type RppEditLockResult =
  | { ok: true; token: string; lock: RppEditLock }
  | { ok: false; lock: RppEditLock };

const TABLE = "rpp_edit_locks";
export const RPP_EDIT_LOCK_TTL_MS = 5 * 60 * 1000;
let fileMutationQueue: Promise<unknown> = Promise.resolve();

function normalizedItemCode(value: string) {
  const itemCode = String(value || "").trim().toLowerCase();
  if (!itemCode) throw new Error("itemCode is required");
  return itemCode;
}
function normalizedActor(actor: RppEditActor) {
  const email = String(actor.email || "").trim().toLowerCase();
  if (!email) throw new Error("actor email is required");
  return { email, name: String(actor.name || "").trim() || email.split("@")[0] };
}
function publicLock(lock: StoredRppEditLock): RppEditLock {
  return { itemCode: lock.itemCode, actorName: lock.actorName, expiresAt: lock.expiresAt, updatedAt: lock.updatedAt };
}
function dataPath() {
  const dir = process.env.RPP_COLLAB_DATA_DIR
    ?? path.join(process.env.RPP_PROJECT_DIR ?? (process.platform === "darwin" ? "/Users/nob/Projects/rpp-8am-notify" : "/var/data/rpp-8am-notify"), "rpp_targets");
  return path.join(dir, "rpp_edit_locks.json");
}
async function ensureTable() {
  if (!pool) return;
  await pool.query(`create table if not exists ${TABLE} (
    item_code text primary key,
    actor_email text not null,
    actor_name text not null,
    lock_token text not null,
    expires_at timestamptz not null,
    updated_at timestamptz not null default now()
  )`);
}
function mapDbLock(row: Record<string, unknown>): StoredRppEditLock {
  return {
    itemCode: String(row.item_code),
    actorEmail: String(row.actor_email),
    actorName: String(row.actor_name),
    token: String(row.lock_token),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}
async function readFileLocks(): Promise<StoredRppEditLock[]> {
  try {
    const raw = JSON.parse(await fs.readFile(dataPath(), "utf8")) as { locks?: StoredRppEditLock[] };
    return Array.isArray(raw.locks) ? raw.locks : [];
  } catch { return []; }
}
async function writeFileLocks(locks: StoredRppEditLock[]) {
  const filePath = dataPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ updatedAt: new Date().toISOString(), locks }, null, 2));
}
function mutateFile<T>(operation: () => Promise<T>): Promise<T> {
  const run = fileMutationQueue.then(operation, operation);
  fileMutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

export async function acquireRppEditLock(itemCodeInput: string, actorInput: RppEditActor, ttlMs = RPP_EDIT_LOCK_TTL_MS): Promise<RppEditLockResult> {
  const itemCode = normalizedItemCode(itemCodeInput);
  const actor = normalizedActor(actorInput);
  const proposedToken = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await ensureTable();
  if (pool) {
    const inserted = await pool.query(
      `insert into ${TABLE} (item_code, actor_email, actor_name, lock_token, expires_at, updated_at)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (item_code) do update set
         actor_email=excluded.actor_email,
         actor_name=excluded.actor_name,
         lock_token=case when ${TABLE}.actor_email=excluded.actor_email and ${TABLE}.expires_at>$6 then ${TABLE}.lock_token else excluded.lock_token end,
         expires_at=excluded.expires_at,
         updated_at=excluded.updated_at
       where ${TABLE}.expires_at<=$6 or ${TABLE}.actor_email=excluded.actor_email
       returning *`,
      [itemCode, actor.email, actor.name, proposedToken, expiresAt, now],
    );
    if (inserted.rows[0]) {
      const lock = mapDbLock(inserted.rows[0]);
      return { ok: true, token: lock.token, lock: publicLock(lock) };
    }
    const current = await pool.query(`select * from ${TABLE} where item_code=$1`, [itemCode]);
    return { ok: false, lock: publicLock(mapDbLock(current.rows[0])) };
  }
  return mutateFile(async () => {
    const locks = await readFileLocks();
    const index = locks.findIndex((row) => row.itemCode === itemCode);
    const current = index >= 0 ? locks[index] : null;
    if (current && Date.parse(current.expiresAt) > now.getTime() && current.actorEmail !== actor.email) {
      return { ok: false, lock: publicLock(current) };
    }
    const token = current && Date.parse(current.expiresAt) > now.getTime() && current.actorEmail === actor.email ? current.token : proposedToken;
    const next: StoredRppEditLock = { itemCode, actorEmail: actor.email, actorName: actor.name, token, expiresAt: expiresAt.toISOString(), updatedAt: now.toISOString() };
    if (index >= 0) locks[index] = next; else locks.push(next);
    await writeFileLocks(locks);
    return { ok: true, token, lock: publicLock(next) };
  });
}

export async function heartbeatRppEditLock(itemCodeInput: string, token: string, actorEmailInput: string, ttlMs = RPP_EDIT_LOCK_TTL_MS): Promise<RppEditLock | null> {
  const itemCode = normalizedItemCode(itemCodeInput);
  const actorEmail = normalizedActor({ email: actorEmailInput, name: "" }).email;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await ensureTable();
  if (pool) {
    const result = await pool.query(
      `update ${TABLE} set expires_at=$4, updated_at=$3 where item_code=$1 and lock_token=$2 and actor_email=$5 and expires_at>$3 returning *`,
      [itemCode, token, now, expiresAt, actorEmail],
    );
    return result.rows[0] ? publicLock(mapDbLock(result.rows[0])) : null;
  }
  return mutateFile(async () => {
    const locks = await readFileLocks();
    const index = locks.findIndex((row) => row.itemCode === itemCode && row.token === token && row.actorEmail === actorEmail && Date.parse(row.expiresAt) > now.getTime());
    if (index < 0) return null;
    locks[index] = { ...locks[index], expiresAt: expiresAt.toISOString(), updatedAt: now.toISOString() };
    await writeFileLocks(locks);
    return publicLock(locks[index]);
  });
}

export async function releaseRppEditLock(itemCodeInput: string, token: string, actorEmailInput: string): Promise<boolean> {
  const itemCode = normalizedItemCode(itemCodeInput);
  const actorEmail = normalizedActor({ email: actorEmailInput, name: "" }).email;
  await ensureTable();
  if (pool) {
    const result = await pool.query(`delete from ${TABLE} where item_code=$1 and lock_token=$2 and actor_email=$3`, [itemCode, token, actorEmail]);
    return (result.rowCount ?? 0) > 0;
  }
  return mutateFile(async () => {
    const locks = await readFileLocks();
    const next = locks.filter((row) => !(row.itemCode === itemCode && row.token === token && row.actorEmail === actorEmail));
    if (next.length === locks.length) return false;
    await writeFileLocks(next);
    return true;
  });
}

export async function listActiveRppEditLocks(): Promise<RppEditLock[]> {
  const now = new Date();
  await ensureTable();
  if (pool) {
    await pool.query(`delete from ${TABLE} where expires_at<=now()`);
    const result = await pool.query(`select * from ${TABLE} order by updated_at desc`);
    return result.rows.map((row) => publicLock(mapDbLock(row)));
  }
  return mutateFile(async () => {
    const locks = await readFileLocks();
    const active = locks.filter((row) => Date.parse(row.expiresAt) > now.getTime());
    if (active.length !== locks.length) await writeFileLocks(active);
    return active.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicLock);
  });
}
