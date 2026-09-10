import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";

import { pool } from "./db.ts";

export const RPP_DELIVERY_TIME_ZONE = "Asia/Tokyo" as const;

export type RppRecurringSchedule = {
  enabled: boolean;
  startTime: string;
  endTime: string;
};

export type RppProductDeliverySchedule = {
  itemCode: string;
  recurring: RppRecurringSchedule;
  updatedAt: string;
};

export type RppDeliveryReservationAction = "ON" | "OFF";
export type RppDeliveryReservationStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export type RppDeliveryReservation = {
  id: string;
  itemCode: string;
  action: RppDeliveryReservationAction;
  executeAt: string;
  status: RppDeliveryReservationStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  claimId: string | null;
  claimExpiresAt: string | null;
  attempts: number;
};

export type RppDeliverySchedulesData = {
  source: string;
  timeZone: typeof RPP_DELIVERY_TIME_ZONE;
  schedules: RppProductDeliverySchedule[];
  reservations: RppDeliveryReservation[];
};

const SCHEDULES_TABLE = "rpp_product_delivery_schedules";
const RESERVATIONS_TABLE = "rpp_product_delivery_reservations";
const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
let fallbackMutation = Promise.resolve();

function projectDir() {
  return process.env.RPP_PROJECT_DIR ?? (process.platform === "darwin" ? "/Users/nob/Projects/rpp-8am-notify" : "/tmp/rpp-8am-notify");
}

function fallbackPath() {
  return path.join(projectDir(), "rpp_targets", "rpp_delivery_schedules.json");
}

export function normalizeRppDeliveryItemCode(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function requireItemCode(value: unknown) {
  const itemCode = normalizeRppDeliveryItemCode(value);
  if (!itemCode) throw new Error("商品管理番号は必須です");
  return itemCode;
}

function normalizeTime(value: unknown, field: string) {
  const time = String(value ?? "").trim();
  if (!HH_MM.test(time)) throw new Error(`${field}はHH:mm形式で指定してください`);
  return time;
}

function validateRecurring(value: RppRecurringSchedule): RppRecurringSchedule {
  if (typeof value?.enabled !== "boolean") throw new Error("enabledはbooleanで指定してください");
  const startTime = normalizeTime(value.startTime, "startTime");
  const endTime = normalizeTime(value.endTime, "endTime");
  if (startTime === endTime) throw new Error("開始と終了は異なる時刻にしてください");
  return { enabled: value.enabled, startTime, endTime };
}

function normalizeIso(value: unknown, field: string) {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) throw new Error(`${field}が不正です`);
  return date.toISOString();
}

function normalizeSchedule(value: Partial<RppProductDeliverySchedule>): RppProductDeliverySchedule | null {
  const itemCode = normalizeRppDeliveryItemCode(value.itemCode);
  if (!itemCode || !value.recurring) return null;
  try {
    return {
      itemCode,
      recurring: validateRecurring(value.recurring),
      updatedAt: normalizeIso(value.updatedAt ?? new Date(0), "updatedAt"),
    };
  } catch {
    return null;
  }
}

function isReservationAction(value: unknown): value is RppDeliveryReservationAction {
  return value === "ON" || value === "OFF";
}

function isReservationStatus(value: unknown): value is RppDeliveryReservationStatus {
  return value === "PENDING" || value === "SUCCEEDED" || value === "FAILED" || value === "CANCELLED";
}

function normalizeReservation(value: Partial<RppDeliveryReservation>): RppDeliveryReservation | null {
  const itemCode = normalizeRppDeliveryItemCode(value.itemCode);
  if (!value.id || !itemCode || !isReservationAction(value.action) || !isReservationStatus(value.status)) return null;
  try {
    return {
      id: String(value.id),
      itemCode,
      action: value.action,
      executeAt: normalizeIso(value.executeAt, "executeAt"),
      status: value.status,
      error: value.error == null || value.error === "" ? null : String(value.error),
      createdAt: normalizeIso(value.createdAt, "createdAt"),
      updatedAt: normalizeIso(value.updatedAt, "updatedAt"),
      claimId: value.claimId == null || value.claimId === "" ? null : String(value.claimId),
      claimExpiresAt: value.claimExpiresAt == null ? null : normalizeIso(value.claimExpiresAt, "claimExpiresAt"),
      attempts: Number.isInteger(value.attempts) && Number(value.attempts) >= 0 ? Number(value.attempts) : 0,
    };
  } catch {
    return null;
  }
}

function normalizedData(source: string, value: Partial<RppDeliverySchedulesData> = {}): RppDeliverySchedulesData {
  return {
    source,
    timeZone: RPP_DELIVERY_TIME_ZONE,
    schedules: (Array.isArray(value.schedules) ? value.schedules : [])
      .map(normalizeSchedule)
      .filter((row): row is RppProductDeliverySchedule => row !== null)
      .sort((a, b) => a.itemCode.localeCompare(b.itemCode, "ja")),
    reservations: (Array.isArray(value.reservations) ? value.reservations : [])
      .map(normalizeReservation)
      .filter((row): row is RppDeliveryReservation => row !== null)
      .sort((a, b) => a.executeAt.localeCompare(b.executeAt) || a.id.localeCompare(b.id)),
  };
}

async function ensureTables() {
  if (!pool) return;
  await pool.query(`create table if not exists ${SCHEDULES_TABLE} (
    item_code text primary key,
    enabled boolean not null default false,
    start_time char(5) not null,
    end_time char(5) not null,
    updated_at timestamptz not null default now(),
    check (start_time ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'),
    check (end_time ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'),
    check (start_time <> end_time)
  )`);
  await pool.query(`create table if not exists ${RESERVATIONS_TABLE} (
    id uuid primary key,
    item_code text not null,
    action text not null check (action in ('ON','OFF')),
    execute_at timestamptz not null,
    status text not null default 'PENDING' check (status in ('PENDING','SUCCEEDED','FAILED','CANCELLED')),
    error text,
    claim_id uuid,
    claim_expires_at timestamptz,
    attempts integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(item_code,execute_at)
  )`);
  await pool.query(`alter table ${RESERVATIONS_TABLE} add column if not exists claim_id uuid`);
  await pool.query(`alter table ${RESERVATIONS_TABLE} add column if not exists claim_expires_at timestamptz`);
  await pool.query(`alter table ${RESERVATIONS_TABLE} add column if not exists attempts integer not null default 0`);
  await pool.query(`create unique index if not exists ${RESERVATIONS_TABLE}_item_time_uidx on ${RESERVATIONS_TABLE} (item_code,execute_at)`);
  await pool.query(`create index if not exists ${RESERVATIONS_TABLE}_pending_idx on ${RESERVATIONS_TABLE} (execute_at) where status='PENDING'`);
}

export async function readRppDeliverySchedules(): Promise<RppDeliverySchedulesData> {
  if (pool) {
    await ensureTables();
    const [scheduleRows, reservationRows] = await Promise.all([
      pool.query(`select item_code,enabled,start_time,end_time,updated_at from ${SCHEDULES_TABLE} order by item_code`),
      pool.query(`select id,item_code,action,execute_at,status,error,created_at,updated_at,claim_id,claim_expires_at,attempts from ${RESERVATIONS_TABLE} order by execute_at,id`),
    ]);
    return normalizedData(`db:${SCHEDULES_TABLE},${RESERVATIONS_TABLE}`, {
      schedules: scheduleRows.rows.map((row) => ({ itemCode: row.item_code, recurring: { enabled: row.enabled === true, startTime: row.start_time.trim(), endTime: row.end_time.trim() }, updatedAt: new Date(row.updated_at).toISOString() })),
      reservations: reservationRows.rows.map((row) => ({ id: row.id, itemCode: row.item_code, action: row.action, executeAt: new Date(row.execute_at).toISOString(), status: row.status, error: row.error, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), claimId: row.claim_id, claimExpiresAt: row.claim_expires_at == null ? null : new Date(row.claim_expires_at).toISOString(), attempts: row.attempts })),
    });
  }
  if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required for RPP delivery schedules");
  const target = fallbackPath();
  try {
    return normalizedData(target, JSON.parse(await fs.readFile(target, "utf8")));
  } catch {
    return normalizedData(target);
  }
}

async function writeFallback(data: RppDeliverySchedulesData) {
  const target = fallbackPath();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify({ timeZone: RPP_DELIVERY_TIME_ZONE, schedules: data.schedules, reservations: data.reservations }, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
}

function mutateFallback<T>(operation: () => Promise<T>): Promise<T> {
  const next = fallbackMutation.then(operation, operation);
  fallbackMutation = next.then(() => undefined, () => undefined);
  return next;
}

export async function writeRppRecurringSchedule(itemCodeInput: unknown, recurringInput: RppRecurringSchedule) {
  const itemCode = requireItemCode(itemCodeInput);
  const recurring = validateRecurring(recurringInput);
  if (pool) {
    await ensureTables();
    await pool.query(
      `insert into ${SCHEDULES_TABLE}(item_code,enabled,start_time,end_time,updated_at) values($1,$2,$3,$4,now())
       on conflict(item_code) do update set enabled=excluded.enabled,start_time=excluded.start_time,end_time=excluded.end_time,updated_at=now()`,
      [itemCode, recurring.enabled, recurring.startTime, recurring.endTime],
    );
    return readRppDeliverySchedules();
  }
  return mutateFallback(async () => {
    const data = await readRppDeliverySchedules();
    data.schedules = data.schedules.filter((row) => row.itemCode !== itemCode);
    data.schedules.push({ itemCode, recurring, updatedAt: new Date().toISOString() });
    const normalized = normalizedData(data.source, data);
    await writeFallback(normalized);
    return normalized;
  });
}

export function jstLocalDateTimeToIso(value: unknown, timeZone: unknown) {
  if (timeZone !== RPP_DELIVERY_TIME_ZONE) throw new Error("timeZoneはAsia/Tokyoを指定してください");
  const local = String(value ?? "").trim();
  const match = LOCAL_DATE_TIME.exec(local);
  if (!match) throw new Error("executeAtはdatetime-local形式で指定してください");
  const [, year, month, day, hour, minute] = match;
  const date = new Date(`${local}:00+09:00`);
  if (Number.isNaN(date.getTime())) throw new Error("executeAtが不正です");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: RPP_DELIVERY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const actual = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (actual.year !== year || actual.month !== month || actual.day !== day || actual.hour !== hour || actual.minute !== minute) throw new Error("executeAtが不正です");
  return date.toISOString();
}

export async function createRppDeliveryReservation(itemCodeInput: unknown, actionInput: unknown, executeAtInput: unknown, timeZone: unknown, now = new Date()) {
  const itemCode = requireItemCode(itemCodeInput);
  if (!isReservationAction(actionInput)) throw new Error("actionはONまたはOFFで指定してください");
  const executeAt = jstLocalDateTimeToIso(executeAtInput, timeZone);
  if (new Date(executeAt).getTime() <= now.getTime()) throw new Error("予約日時は未来を指定してください");
  const timestamp = new Date().toISOString();
  const reservation: RppDeliveryReservation = { id: randomUUID(), itemCode, action: actionInput, executeAt, status: "PENDING", error: null, createdAt: timestamp, updatedAt: timestamp, claimId: null, claimExpiresAt: null, attempts: 0 };
  if (pool) {
    await ensureTables();
    const existing = await pool.query(
      `select id,item_code,action,execute_at,status,error,created_at,updated_at,claim_id,claim_expires_at,attempts from ${RESERVATIONS_TABLE} where item_code=$1 and execute_at=$2 limit 1`,
      [itemCode, executeAt],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.action !== actionInput) throw new Error("同じ商品・日時にONとOFFを同時登録できません");
      return { reservation: normalizeReservation({ id: row.id, itemCode: row.item_code, action: row.action, executeAt: row.execute_at, status: row.status, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at, claimId: row.claim_id, claimExpiresAt: row.claim_expires_at, attempts: row.attempts })! };
    }
    const result = await pool.query(
      `insert into ${RESERVATIONS_TABLE}(id,item_code,action,execute_at,status,error,created_at,updated_at) values($1,$2,$3,$4,'PENDING',null,now(),now()) returning id,item_code,action,execute_at,status,error,created_at,updated_at,claim_id,claim_expires_at,attempts`,
      [reservation.id, itemCode, actionInput, executeAt],
    );
    const row = result.rows[0];
    return { reservation: normalizeReservation({ id: row.id, itemCode: row.item_code, action: row.action, executeAt: row.execute_at, status: row.status, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at, claimId: row.claim_id, claimExpiresAt: row.claim_expires_at, attempts: row.attempts })! };
  }
  return mutateFallback(async () => {
    const data = await readRppDeliverySchedules();
    const existing = data.reservations.find((row) => row.itemCode === itemCode && row.executeAt === executeAt);
    if (existing) {
      if (existing.action !== actionInput) throw new Error("同じ商品・日時にONとOFFを同時登録できません");
      return { reservation: existing };
    }
    data.reservations.push(reservation);
    await writeFallback(normalizedData(data.source, data));
    return { reservation };
  });
}

async function updateFallbackReservation(id: string, updater: (row: RppDeliveryReservation) => RppDeliveryReservation) {
  return mutateFallback(async () => {
    const data = await readRppDeliverySchedules();
    const index = data.reservations.findIndex((row) => row.id === id);
    if (index < 0) throw new Error(`予約が見つかりません: ${id}`);
    if (data.reservations[index].status !== "PENDING") throw new Error("PENDINGの予約だけ更新できます");
    const reservation = updater(data.reservations[index]);
    data.reservations[index] = reservation;
    await writeFallback(normalizedData(data.source, data));
    return { reservation };
  });
}

export async function cancelRppDeliveryReservation(reservationIdInput: unknown, itemCodeInput?: unknown) {
  const reservationId = String(reservationIdInput ?? "").trim();
  if (!reservationId) throw new Error("reservationIdは必須です");
  const itemCode = itemCodeInput == null ? null : requireItemCode(itemCodeInput);
  if (pool) {
    await ensureTables();
    const result = await pool.query(
      `update ${RESERVATIONS_TABLE} set status='CANCELLED',error=null,updated_at=now() where id=$1 and status='PENDING' and (claim_id is null or claim_expires_at<=now()) and ($2::text is null or item_code=$2) returning id,item_code,action,execute_at,status,error,created_at,updated_at,claim_id,claim_expires_at,attempts`,
      [reservationId, itemCode],
    );
    if (!result.rows[0]) throw new Error("PENDINGの予約が見つかりません");
    const row = result.rows[0];
    return { reservation: normalizeReservation({ id: row.id, itemCode: row.item_code, action: row.action, executeAt: row.execute_at, status: row.status, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at })! };
  }
  return updateFallbackReservation(reservationId, (row) => {
    if (itemCode && row.itemCode !== itemCode) throw new Error("予約の商品管理番号が一致しません");
    if (row.claimId && row.claimExpiresAt && new Date(row.claimExpiresAt).getTime() > Date.now()) throw new Error("実行処理中の予約は取消できません");
    return { ...row, status: "CANCELLED", error: null, claimId: null, claimExpiresAt: null, updatedAt: new Date().toISOString() };
  });
}

export async function readPendingRppDeliveryReservations() {
  if (!pool) {
    const data = await readRppDeliverySchedules();
    return data.reservations.filter((row) => row.status === "PENDING");
  }
  await ensureTables();
  const result = await pool.query(`select id,item_code,action,execute_at,status,error,created_at,updated_at,claim_id,claim_expires_at,attempts from ${RESERVATIONS_TABLE} where status='PENDING' order by execute_at,id`);
  return result.rows.map((row) => normalizeReservation({ id: row.id, itemCode: row.item_code, action: row.action, executeAt: row.execute_at, status: row.status, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at, claimId: row.claim_id, claimExpiresAt: row.claim_expires_at, attempts: row.attempts })!).filter(Boolean);
}

export async function claimRppDeliveryReservation(reservationIdInput: unknown, now = new Date()) {
  const reservationId = String(reservationIdInput ?? "").trim();
  if (!reservationId) throw new Error("reservationIdは必須です");
  const claimId = randomUUID();
  const claimExpiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  if (pool) {
    await ensureTables();
    const result = await pool.query(
      `update ${RESERVATIONS_TABLE} set claim_id=$2,claim_expires_at=$3,attempts=attempts+1,updated_at=now() where id=$1 and status='PENDING' and execute_at<=$4 and (claim_id is null or claim_expires_at<=$4) returning id,item_code,action,execute_at,status,error,created_at,updated_at,claim_id,claim_expires_at,attempts`,
      [reservationId, claimId, claimExpiresAt, now.toISOString()],
    );
    if (!result.rows[0]) throw new Error("実行可能なPENDING予約が見つかりません");
    const row = result.rows[0];
    return { reservation: normalizeReservation({ id: row.id, itemCode: row.item_code, action: row.action, executeAt: row.execute_at, status: row.status, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at, claimId: row.claim_id, claimExpiresAt: row.claim_expires_at, attempts: row.attempts })! };
  }
  return updateFallbackReservation(reservationId, (row) => {
    if (new Date(row.executeAt).getTime() > now.getTime()) throw new Error("予約日時前です");
    if (row.claimId && row.claimExpiresAt && new Date(row.claimExpiresAt).getTime() > now.getTime()) throw new Error("予約は別の実行処理がclaim済みです");
    return { ...row, claimId, claimExpiresAt, attempts: row.attempts + 1, updatedAt: new Date().toISOString() };
  });
}

export async function markRppDeliveryReservation(reservationIdInput: unknown, claimIdInput: unknown, statusInput: unknown, errorInput?: unknown) {
  const reservationId = String(reservationIdInput ?? "").trim();
  const claimId = String(claimIdInput ?? "").trim();
  if (!reservationId) throw new Error("reservationIdは必須です");
  if (!claimId) throw new Error("claimIdは必須です");
  if (statusInput !== "SUCCEEDED" && statusInput !== "FAILED") throw new Error("statusはSUCCEEDEDまたはFAILEDで指定してください");
  const error = statusInput === "FAILED" ? String(errorInput ?? "").trim() || "実行に失敗しました" : null;
  if (pool) {
    await ensureTables();
    const result = await pool.query(
      `update ${RESERVATIONS_TABLE} set status=$3,error=$4,claim_expires_at=null,updated_at=now() where id=$1 and status='PENDING' and claim_id=$2 returning id,item_code,action,execute_at,status,error,created_at,updated_at,claim_id,claim_expires_at,attempts`,
      [reservationId, claimId, statusInput, error],
    );
    if (result.rows[0]) {
      const row = result.rows[0];
      return { reservation: normalizeReservation({ id: row.id, itemCode: row.item_code, action: row.action, executeAt: row.execute_at, status: row.status, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at, claimId: row.claim_id, claimExpiresAt: row.claim_expires_at, attempts: row.attempts })! };
    }
    const existing = await pool.query(`select id,item_code,action,execute_at,status,error,created_at,updated_at,claim_id,claim_expires_at,attempts from ${RESERVATIONS_TABLE} where id=$1`, [reservationId]);
    const row = existing.rows[0];
    if (row && row.status === statusInput && row.claim_id === claimId) {
      return { reservation: normalizeReservation({ id: row.id, itemCode: row.item_code, action: row.action, executeAt: row.execute_at, status: row.status, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at, claimId: row.claim_id, claimExpiresAt: row.claim_expires_at, attempts: row.attempts })! };
    }
    throw new Error("claimが一致するPENDING予約が見つかりません");
  }
  return mutateFallback(async () => {
    const data = await readRppDeliverySchedules();
    const index = data.reservations.findIndex((row) => row.id === reservationId);
    if (index < 0) throw new Error(`予約が見つかりません: ${reservationId}`);
    const row = data.reservations[index];
    if (row.status === statusInput && row.claimId === claimId) return { reservation: row };
    if (row.status !== "PENDING" || row.claimId !== claimId) throw new Error("claimが一致するPENDING予約が見つかりません");
    const reservation: RppDeliveryReservation = { ...row, status: statusInput, error, claimExpiresAt: null, updatedAt: new Date().toISOString() };
    data.reservations[index] = reservation;
    await writeFallback(normalizedData(data.source, data));
    return { reservation };
  });
}
