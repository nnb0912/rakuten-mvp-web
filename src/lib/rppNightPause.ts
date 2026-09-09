import { promises as fs } from "fs";
import path from "path";

import { pool } from "./db.ts";

export type RppNightPauseProduct = {
  itemCode: string;
  enabled: boolean;
  updatedAt: string;
};

export type RppNightPauseProducts = {
  source: string;
  products: RppNightPauseProduct[];
  itemCodes: string[];
};

const TABLE = "rpp_night_pause_products";

function projectDir() {
  return process.env.RPP_PROJECT_DIR ?? (process.platform === "darwin" ? "/Users/nob/Projects/rpp-8am-notify" : "/tmp/rpp-8am-notify");
}

function filePath() {
  return path.join(projectDir(), "rpp_targets", "rpp_night_pause_products.json");
}

export function normalizeRppNightPauseItemCode(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeProduct(value: Partial<RppNightPauseProduct>): RppNightPauseProduct | null {
  const itemCode = normalizeRppNightPauseItemCode(value.itemCode);
  if (!itemCode) return null;
  const date = new Date(String(value.updatedAt ?? ""));
  return {
    itemCode,
    enabled: value.enabled === true,
    updatedAt: Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString(),
  };
}

function result(source: string, products: Partial<RppNightPauseProduct>[]): RppNightPauseProducts {
  const normalized = products
    .map(normalizeProduct)
    .filter((row): row is RppNightPauseProduct => row !== null)
    .sort((a, b) => a.itemCode.localeCompare(b.itemCode, "ja"));
  return {
    source,
    products: normalized,
    itemCodes: normalized.filter((row) => row.enabled).map((row) => row.itemCode),
  };
}

async function ensureTable() {
  if (!pool) return;
  await pool.query(`create table if not exists ${TABLE} (
    item_code text primary key,
    enabled boolean not null default false,
    updated_at timestamptz not null default now()
  )`);
}

export async function readRppNightPauseProducts(): Promise<RppNightPauseProducts> {
  if (pool) {
    await ensureTable();
    const rows = await pool.query(`select item_code, enabled, updated_at from ${TABLE} order by item_code`);
    return result(`db:${TABLE}`, rows.rows.map((row) => ({
      itemCode: String(row.item_code),
      enabled: row.enabled === true,
      updatedAt: new Date(row.updated_at).toISOString(),
    })));
  }

  const target = filePath();
  try {
    const value = JSON.parse(await fs.readFile(target, "utf8")) as { products?: Partial<RppNightPauseProduct>[] } | Partial<RppNightPauseProduct>[];
    return result(target, Array.isArray(value) ? value as RppNightPauseProduct[] : value.products ?? []);
  } catch {
    return result(target, []);
  }
}

export async function writeRppNightPauseProduct(itemCodeInput: unknown, enabled: boolean): Promise<RppNightPauseProducts> {
  const itemCode = normalizeRppNightPauseItemCode(itemCodeInput);
  if (!itemCode) throw new Error("商品管理番号は必須です");
  if (typeof enabled !== "boolean") throw new Error("enabledはbooleanで指定してください");

  if (pool) {
    await ensureTable();
    await pool.query(
      `insert into ${TABLE} (item_code, enabled, updated_at) values ($1,$2,now())
       on conflict (item_code) do update set enabled=excluded.enabled, updated_at=now()`,
      [itemCode, enabled],
    );
    return readRppNightPauseProducts();
  }

  const current = await readRppNightPauseProducts();
  const now = new Date().toISOString();
  const products = current.products.filter((row) => row.itemCode !== itemCode);
  products.push({ itemCode, enabled, updatedAt: now });
  const target = filePath();
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify({ products: result(target, products).products }, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
  return readRppNightPauseProducts();
}
