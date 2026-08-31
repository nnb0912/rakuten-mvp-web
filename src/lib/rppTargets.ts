import { promises as fs } from "fs";
import path from "path";
import configuredTargetsSnapshot from "@/data/rpp_configured_targets.json";
import { pool } from "@/lib/db";
import { readRppExclusionOverrides } from "@/lib/rppExclusionJobs";
import type { RppOptimizationMode } from "@/lib/rppOptimization";

export type RppPositionGoal = "FIRST_PAGE" | "TOP_7" | "TOP_5" | "TOP_3";
export type RppOperationPolicy = "攻め" | "維持" | "テスト" | "停止候補";
export type RppProtectionType = "NORMAL" | "BLOCK" | "WHITELIST" | "LOCKED" | "FOCUS";
export type RppExperimentBaseline = {
  capturedAt: string;
  ctr: number | null;
  cvr: number | null;
  roas: number | null;
  pcPosition: string;
  spPosition: string;
};

export type RppAlertTarget = {
  id: string;
  itemCode: string;
  keyword: string;
  owner: string;
  ctrGoal: number;
  cvrGoal: number;
  roasFloor: number;
  positionGoal: RppPositionGoal;
  pcPositionGoal: RppPositionGoal;
  spPositionGoal: RppPositionGoal;
  policy: RppOperationPolicy;
  note: string;
  adGroup: string;
  changeLocked: boolean;
  lockReason: string;
  protectionType: RppProtectionType;
  searchKeywords: string[];
  optimizationMode: RppOptimizationMode;
  fixedCpc: number | null;
  maxCpc: number | null;
  experimentEndDate: string;
  experimentStartedAt: string;
  experimentBaseline: RppExperimentBaseline | null;
  createdAt: string;
  updatedAt: string;
};

export type RppConfiguredTarget = {
  id: string;
  itemCode: string;
  itemName: string;
  keyword: string;
  itemCpc: number | null;
  keywordCpc: number | null;
  source: "商品CPC" | "キーワードCPC";
  owner?: string;
  rppPosition?: string;
  rppPositionKeyword?: string;
  rppPositions?: { keyword: string; position: string }[];
};

export type RppExclusionProduct = {
  itemCode: string;
  itemName: string;
  itemCpc: number | null;
  excluded: boolean;
  owner?: string;
};

export type RppAlertTargetInput = {
  itemCode: string;
  keyword: string;
  owner?: string;
  ctrGoal?: number;
  cvrGoal?: number;
  roasFloor?: number;
  positionGoal?: RppPositionGoal;
  pcPositionGoal?: RppPositionGoal;
  spPositionGoal?: RppPositionGoal;
  policy?: RppOperationPolicy;
  note?: string;
  adGroup?: string;
  changeLocked?: boolean;
  lockReason?: string;
  protectionType?: RppProtectionType;
  searchKeywords?: string[] | string;
  optimizationMode?: RppOptimizationMode;
  fixedCpc?: number | null;
  maxCpc?: number | null;
  experimentEndDate?: string;
  experimentStartedAt?: string;
  experimentBaseline?: RppExperimentBaseline | null;
};

const DEFAULT_RPP_PROJECT_DIR = "/Users/nob/Projects/rpp-8am-notify";
const RPP_PROJECT_DIR = process.env.RPP_PROJECT_DIR ?? (process.platform === "darwin" ? DEFAULT_RPP_PROJECT_DIR : "/tmp/rpp-8am-notify");
const DATA_DIR = path.join(RPP_PROJECT_DIR, "rpp_targets");
const TARGETS_PATH = path.join(DATA_DIR, "rpp_alert_targets.json");
const TARGETS_TABLE = "rpp_alert_targets";
const ITEM_SETTINGS_PATH = path.join(RPP_PROJECT_DIR, "rpp_item_settings.csv");
const KEYWORD_SETTINGS_PATH = path.join(RPP_PROJECT_DIR, "rpp_keyword_settings.csv");
const SNAPSHOT_TARGETS_PATH = path.join(process.cwd(), "src", "data", "rpp_configured_targets.json");
const SNAPSHOT_EXCLUSION_PRODUCTS_PATH = path.join(process.cwd(), "src", "data", "rpp_exclusion_products.json");
const SNAPSHOT_OWNER_MAP_PATH = path.join(process.cwd(), "src", "data", "rpp_owner_map.json");

const POSITION_GOALS: RppPositionGoal[] = ["FIRST_PAGE", "TOP_7", "TOP_5", "TOP_3"];
const POLICIES: RppOperationPolicy[] = ["攻め", "維持", "テスト", "停止候補"];
const OPTIMIZATION_MODES: RppOptimizationMode[] = ["ROAS", "POSITION", "FIXED"];
const PROTECTION_TYPES: RppProtectionType[] = ["NORMAL", "BLOCK", "WHITELIST", "LOCKED", "FOCUS"];

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function finiteNumber(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optionalNumber(value: unknown) {
  const n = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeSearchKeywords(value: unknown, fallbackKeyword: string) {
  const raw = Array.isArray(value) ? value.join("\n") : String(value ?? "");
  const parts = raw.split(/[\n,、]+/).map(cleanText).filter(Boolean);
  const unique = [...new Set(parts)];
  if (unique.length) return unique;
  return fallbackKeyword && fallbackKeyword !== "商品CPC" ? [fallbackKeyword] : [];
}

export function targetId(itemCode: string, keyword: string) {
  return [itemCode.trim().toLowerCase(), keyword.trim()].map((part) => encodeURIComponent(part)).join("__");
}

function normalizeInput(input: RppAlertTargetInput) {
  const itemCode = cleanText(input.itemCode).toLowerCase();
  const keyword = cleanText(input.keyword);
  if (!itemCode) throw new Error("商品管理番号は必須です");
  if (!keyword) throw new Error("キーワードは必須です");
  const searchKeywords = normalizeSearchKeywords(input.searchKeywords, keyword);
  if (keyword === "商品CPC" && searchKeywords.length === 0) {
    throw new Error("商品CPCの場合は検索調査キーワードを1つ以上入力してください");
  }
  const positionGoal = POSITION_GOALS.includes(input.positionGoal as RppPositionGoal) ? input.positionGoal as RppPositionGoal : "FIRST_PAGE";
  const pcPositionGoal = POSITION_GOALS.includes(input.pcPositionGoal as RppPositionGoal) ? input.pcPositionGoal as RppPositionGoal : positionGoal;
  const spPositionGoal = POSITION_GOALS.includes(input.spPositionGoal as RppPositionGoal) ? input.spPositionGoal as RppPositionGoal : positionGoal;
  const policy = POLICIES.includes(input.policy as RppOperationPolicy) ? input.policy as RppOperationPolicy : "維持";
  const optimizationMode = OPTIMIZATION_MODES.includes(input.optimizationMode as RppOptimizationMode) ? input.optimizationMode as RppOptimizationMode : "ROAS";
  const protectionType = PROTECTION_TYPES.includes(input.protectionType as RppProtectionType)
    ? input.protectionType as RppProtectionType
    : input.changeLocked ? "LOCKED" : "NORMAL";
  return {
    itemCode,
    keyword,
    owner: cleanText(input.owner),
    ctrGoal: finiteNumber(input.ctrGoal, 5),
    cvrGoal: finiteNumber(input.cvrGoal, 5),
    roasFloor: finiteNumber(input.roasFloor, 500),
    positionGoal,
    pcPositionGoal,
    spPositionGoal,
    policy,
    note: cleanText(input.note),
    adGroup: cleanText(input.adGroup) || "通常",
    changeLocked: protectionType === "LOCKED" || input.changeLocked === true || String(input.changeLocked ?? "").toLowerCase() === "true",
    lockReason: cleanText(input.lockReason),
    protectionType,
    searchKeywords,
    optimizationMode,
    fixedCpc: optionalNumber(input.fixedCpc),
    maxCpc: optionalNumber(input.maxCpc),
    experimentEndDate: cleanText(input.experimentEndDate),
    experimentStartedAt: cleanText(input.experimentStartedAt),
    experimentBaseline: input.experimentBaseline && typeof input.experimentBaseline === "object" ? input.experimentBaseline : null,
  };
}

function withOptimizationDefaults(row: RppAlertTarget): RppAlertTarget {
  return {
    ...row,
    adGroup: row.adGroup || "通常",
    changeLocked: row.changeLocked === true,
    lockReason: row.lockReason || "",
    protectionType: PROTECTION_TYPES.includes(row.protectionType) ? row.protectionType : row.changeLocked ? "LOCKED" : "NORMAL",
    optimizationMode: row.optimizationMode || "ROAS",
    fixedCpc: optionalNumber(row.fixedCpc),
    maxCpc: optionalNumber(row.maxCpc),
    experimentEndDate: row.experimentEndDate || "",
    experimentStartedAt: row.experimentStartedAt || "",
    experimentBaseline: row.experimentBaseline || null,
  };
}

function decodeCsv(buffer: Buffer) {
  const utf8 = buffer.toString("utf8");
  const bad = (utf8.match(/�/g) ?? []).length;
  if (bad === 0) return utf8.replace(/^\uFEFF/, "");
  try {
    return new TextDecoder("shift_jis").decode(buffer).replace(/^\uFEFF/, "");
  } catch {
    return utf8.replace(/^\uFEFF/, "");
  }
}

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

async function readCsv(filePath: string) {
  try {
    const text = decodeCsv(await fs.readFile(filePath));
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) return [] as Record<string, string>[];
    const headers = parseCsvLine(lines[0]).map((h) => h.trim());
    return lines.slice(1).map((line) => {
      const cells = parseCsvLine(line);
      return Object.fromEntries(headers.map((header, idx) => [header, cleanText(cells[idx])]));
    });
  } catch {
    return [] as Record<string, string>[];
  }
}

async function readOwnerMap(): Promise<Record<string, string>> {
  try {
    const envOwners = process.env.RPP_OWNER_MAP_JSON;
    const raw = envOwners ? JSON.parse(envOwners) : JSON.parse(await fs.readFile(SNAPSHOT_OWNER_MAP_PATH, "utf8"));
    const owners = (raw?.owners ?? raw) as Record<string, string>;
    return Object.fromEntries(Object.entries(owners).map(([code, owner]) => [code.trim().toLowerCase(), cleanText(owner)]));
  } catch {
    return {};
  }
}

async function readConfiguredPositionMap(): Promise<Record<string, { rppPosition?: string; rppPositionKeyword?: string; rppPositions?: { keyword: string; position: string }[] }>> {
  const buildMap = (raw: unknown) => {
    const rows = Array.isArray(raw) ? raw : (raw as { targets?: RppConfiguredTarget[] })?.targets || [];
    const map: Record<string, { rppPosition?: string; rppPositionKeyword?: string; rppPositions?: { keyword: string; position: string }[] }> = {};
    for (const row of rows as RppConfiguredTarget[]) {
      if (row.id && (row.rppPosition || row.rppPositionKeyword || row.rppPositions)) {
        map[row.id] = { rppPosition: row.rppPosition, rppPositionKeyword: row.rppPositionKeyword, rppPositions: row.rppPositions };
      }
    }
    return map;
  };
  const imported = buildMap(configuredTargetsSnapshot);
  if (Object.keys(imported).length) return imported;
  try {
    return buildMap(JSON.parse(await fs.readFile(SNAPSHOT_TARGETS_PATH, "utf8")));
  } catch {
    return {};
  }
}


async function readRawTargets(): Promise<RppAlertTarget[]> {
  if (pool) {
    await ensureRppAlertTargetsTable();
    await migrateLegacyJsonTargetsIfDbEmpty();
    const result = await pool.query<{
      id: string;
      item_code: string;
      keyword: string;
      owner: string;
      ctr_goal: string | number;
      cvr_goal: string | number;
      roas_floor: string | number;
      position_goal: RppPositionGoal;
      pc_position_goal: RppPositionGoal | null;
      sp_position_goal: RppPositionGoal | null;
      policy: RppOperationPolicy;
      note: string | null;
      search_keywords: string[] | string | null;
      ad_group: string | null;
      change_locked: boolean | null;
      lock_reason: string | null;
      protection_type: RppProtectionType | null;
      optimization_mode: RppOptimizationMode | null;
      fixed_cpc: string | number | null;
      max_cpc: string | number | null;
      experiment_end_date: string | null;
      experiment_started_at: string | null;
      experiment_baseline: RppExperimentBaseline | string | null;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `select id, item_code, keyword, owner, ctr_goal, cvr_goal, roas_floor, position_goal, pc_position_goal, sp_position_goal, policy, note, ad_group, change_locked, lock_reason, protection_type, search_keywords, optimization_mode, fixed_cpc, max_cpc, experiment_end_date, experiment_started_at, experiment_baseline, created_at, updated_at
       from ${TARGETS_TABLE}
       order by item_code asc, keyword asc`
    );
    return result.rows.map((row) => ({
      id: row.id,
      itemCode: row.item_code,
      keyword: row.keyword,
      owner: row.owner,
      ctrGoal: Number(row.ctr_goal),
      cvrGoal: Number(row.cvr_goal),
      roasFloor: Number(row.roas_floor),
      positionGoal: row.position_goal,
      pcPositionGoal: row.pc_position_goal ?? row.position_goal,
      spPositionGoal: row.sp_position_goal ?? row.position_goal,
      policy: row.policy,
      note: row.note ?? "",
      adGroup: row.ad_group || "通常",
      changeLocked: row.change_locked === true,
      lockReason: row.lock_reason || "",
      protectionType: PROTECTION_TYPES.includes(row.protection_type as RppProtectionType) ? row.protection_type as RppProtectionType : row.change_locked ? "LOCKED" : "NORMAL",
      searchKeywords: Array.isArray(row.search_keywords)
        ? row.search_keywords
        : typeof row.search_keywords === "string"
          ? JSON.parse(row.search_keywords)
          : [],
      optimizationMode: OPTIMIZATION_MODES.includes(row.optimization_mode as RppOptimizationMode) ? row.optimization_mode as RppOptimizationMode : "ROAS",
      fixedCpc: optionalNumber(row.fixed_cpc),
      maxCpc: optionalNumber(row.max_cpc),
      experimentEndDate: row.experiment_end_date || "",
      experimentStartedAt: row.experiment_started_at || "",
      experimentBaseline: row.experiment_baseline
        ? typeof row.experiment_baseline === "string" ? JSON.parse(row.experiment_baseline) : row.experiment_baseline
        : null,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }
  try {
    const raw = JSON.parse(await fs.readFile(TARGETS_PATH, "utf8")) as unknown;
    if (Array.isArray(raw)) return (raw as RppAlertTarget[]).map(withOptimizationDefaults);
    if (raw && typeof raw === "object" && Array.isArray((raw as { targets?: unknown }).targets)) {
      return (raw as { targets: RppAlertTarget[] }).targets.map(withOptimizationDefaults);
    }
  } catch {}
  return [];
}

async function ensureRppAlertTargetsTable() {
  if (!pool) throw new Error("DATABASE_URLが未設定のため、RPP目標をDB保存できません");
  await pool.query(`
    create table if not exists ${TARGETS_TABLE} (
      id text primary key,
      item_code text not null,
      keyword text not null,
      owner text not null default '',
      ctr_goal numeric not null default 5,
      cvr_goal numeric not null default 5,
      roas_floor numeric not null default 500,
      position_goal text not null default 'FIRST_PAGE',
      pc_position_goal text,
      sp_position_goal text,
      policy text not null default '維持',
      note text not null default '',
      ad_group text not null default '通常',
      change_locked boolean not null default false,
      lock_reason text not null default '',
      protection_type text not null default 'NORMAL',
      search_keywords jsonb not null default '[]'::jsonb,
      optimization_mode text not null default 'ROAS',
      fixed_cpc numeric,
      max_cpc numeric,
      experiment_end_date text not null default '',
      experiment_started_at text not null default '',
      experiment_baseline jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await pool.query(`alter table ${TARGETS_TABLE} add column if not exists pc_position_goal text`);
  await pool.query(`alter table ${TARGETS_TABLE} add column if not exists sp_position_goal text`);
  await pool.query(`alter table ${TARGETS_TABLE} add column if not exists ad_group text not null default '通常'`);
  await pool.query(`alter table ${TARGETS_TABLE} add column if not exists change_locked boolean not null default false`);
  await pool.query(`alter table ${TARGETS_TABLE} add column if not exists lock_reason text not null default ''`);
  await pool.query(`alter table ${TARGETS_TABLE} add column if not exists protection_type text not null default 'NORMAL'`);
  await pool.query(`alter table ${TARGETS_TABLE} add column if not exists optimization_mode text not null default 'ROAS'`);
  await pool.query(`alter table ${TARGETS_TABLE} add column if not exists fixed_cpc numeric`);
  await pool.query(`alter table ${TARGETS_TABLE} add column if not exists max_cpc numeric`);
  await pool.query(`alter table ${TARGETS_TABLE} add column if not exists experiment_end_date text not null default ''`);
  await pool.query(`alter table ${TARGETS_TABLE} add column if not exists experiment_started_at text not null default ''`);
  await pool.query(`alter table ${TARGETS_TABLE} add column if not exists experiment_baseline jsonb`);
  await pool.query(`update ${TARGETS_TABLE} set protection_type = 'LOCKED' where change_locked = true and protection_type = 'NORMAL'`);
  await pool.query(`update ${TARGETS_TABLE} set pc_position_goal = coalesce(pc_position_goal, position_goal, 'FIRST_PAGE'), sp_position_goal = coalesce(sp_position_goal, position_goal, 'FIRST_PAGE') where pc_position_goal is null or sp_position_goal is null`);
}

async function readLegacyJsonTargets(): Promise<RppAlertTarget[]> {
  try {
    const raw = JSON.parse(await fs.readFile(TARGETS_PATH, "utf8")) as unknown;
    if (Array.isArray(raw)) return (raw as RppAlertTarget[]).map(withOptimizationDefaults);
    if (raw && typeof raw === "object" && Array.isArray((raw as { targets?: unknown }).targets)) {
      return (raw as { targets: RppAlertTarget[] }).targets.map(withOptimizationDefaults);
    }
  } catch {}
  return [];
}

async function migrateLegacyJsonTargetsIfDbEmpty() {
  if (!pool) return;
  const countResult = await pool.query<{ count: string }>(`select count(*)::text as count from ${TARGETS_TABLE}`);
  if (Number(countResult.rows[0]?.count ?? 0) > 0) return;
  const legacyTargets = await readLegacyJsonTargets();
  for (const target of legacyTargets) await upsertRawTarget(target);
}

async function upsertRawTarget(target: RppAlertTarget) {
  if (!pool) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const targets = await readLegacyJsonTargets();
    const idx = targets.findIndex((row) => row.id === target.id);
    if (idx >= 0) targets[idx] = target;
    else targets.push(target);
    targets.sort((a, b) => a.itemCode.localeCompare(b.itemCode, "ja") || a.keyword.localeCompare(b.keyword, "ja"));
    await fs.writeFile(TARGETS_PATH, JSON.stringify({ targets }, null, 2));
    return;
  }
  await ensureRppAlertTargetsTable();
  await pool!.query(
    `insert into ${TARGETS_TABLE} (id, item_code, keyword, owner, ctr_goal, cvr_goal, roas_floor, position_goal, pc_position_goal, sp_position_goal, policy, note, ad_group, change_locked, lock_reason, protection_type, search_keywords, optimization_mode, fixed_cpc, max_cpc, experiment_end_date, experiment_started_at, experiment_baseline, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19, $20, $21, $22, $23::jsonb, $24, $25)
     on conflict (id) do update set
       item_code = excluded.item_code,
       keyword = excluded.keyword,
       owner = excluded.owner,
       ctr_goal = excluded.ctr_goal,
       cvr_goal = excluded.cvr_goal,
       roas_floor = excluded.roas_floor,
       position_goal = excluded.position_goal,
       pc_position_goal = excluded.pc_position_goal,
       sp_position_goal = excluded.sp_position_goal,
       policy = excluded.policy,
       note = excluded.note,
       ad_group = excluded.ad_group,
       change_locked = excluded.change_locked,
       lock_reason = excluded.lock_reason,
       protection_type = excluded.protection_type,
       search_keywords = excluded.search_keywords,
       optimization_mode = excluded.optimization_mode,
       fixed_cpc = excluded.fixed_cpc,
       max_cpc = excluded.max_cpc,
       experiment_end_date = excluded.experiment_end_date,
       experiment_started_at = excluded.experiment_started_at,
       experiment_baseline = excluded.experiment_baseline,
       updated_at = excluded.updated_at`,
    [target.id, target.itemCode, target.keyword, target.owner, target.ctrGoal, target.cvrGoal, target.roasFloor, target.positionGoal, target.pcPositionGoal ?? target.positionGoal, target.spPositionGoal ?? target.positionGoal, target.policy, target.note, target.adGroup || "通常", target.changeLocked === true, target.lockReason || "", target.protectionType || (target.changeLocked ? "LOCKED" : "NORMAL"), JSON.stringify(target.searchKeywords), target.optimizationMode || "ROAS", target.fixedCpc, target.maxCpc, target.experimentEndDate || "", target.experimentStartedAt || "", JSON.stringify(target.experimentBaseline), target.createdAt, target.updatedAt]
  );
}

async function deleteRawTarget(id: string) {
  if (!pool) {
    const targets = await readLegacyJsonTargets();
    const decoded = decodeURIComponent(id);
    const next = targets.filter((row) => row.id !== id && row.id !== decoded);
    if (next.length === targets.length) return 0;
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(TARGETS_PATH, JSON.stringify({ targets: next }, null, 2));
    return targets.length - next.length;
  }
  await ensureRppAlertTargetsTable();
  const result = await pool!.query(`delete from ${TARGETS_TABLE} where id = $1 or id = $2`, [id, decodeURIComponent(id)]);
  return result.rowCount ?? 0;
}

export async function readRppConfiguredTargets() {
  const [itemRows, ownerMap, positionMap, exclusionOverrides] = await Promise.all([readCsv(ITEM_SETTINGS_PATH), readOwnerMap(), readConfiguredPositionMap(), readRppExclusionOverrides()]);
  const activeItems = new Map<string, { itemName: string; itemCpc: number | null; owner: string }>();
  for (const row of itemRows) {
    const itemCode = cleanText(row["商品管理番号"]).toLowerCase();
    const itemCpc = optionalNumber(row["商品CPC"]);
    const excluded = exclusionOverrides[itemCode] ?? (cleanText(row["除外登録済み商品"]).toLowerCase() === "yes");
    if (!itemCode || !itemCpc || excluded) continue;
    activeItems.set(itemCode, { itemName: cleanText(row["商品名"]), itemCpc, owner: ownerMap[itemCode] || "担当未設定" });
  }

  const configured = new Map<string, RppConfiguredTarget>();
  for (const [itemCode, item] of activeItems) {
    const keyword = "商品CPC";
    const id = targetId(itemCode, keyword);
    configured.set(id, {
      id,
      itemCode,
      itemName: item.itemName,
      keyword,
      itemCpc: item.itemCpc,
      keywordCpc: null,
      source: "商品CPC",
      owner: item.owner,
      ...positionMap[id],
    });
  }

  const keywordRows = await readCsv(KEYWORD_SETTINGS_PATH);
  for (const row of keywordRows) {
    const itemCode = cleanText(row["商品管理番号"]).toLowerCase();
    const item = activeItems.get(itemCode);
    const keyword = cleanText(row["キーワード"]);
    const keywordCpc = optionalNumber(row["キーワードCPC"]);
    if (!item || !keyword || !keywordCpc) continue;
    const id = targetId(itemCode, keyword);
    configured.set(id, {
      id,
      itemCode,
      itemName: item.itemName || cleanText(row["商品名"]),
      keyword,
      itemCpc: item.itemCpc,
      keywordCpc,
      source: "キーワードCPC",
      owner: item.owner,
      ...positionMap[id],
    });
  }

  const liveRows = [...configured.values()].sort((a, b) => a.itemCode.localeCompare(b.itemCode, "ja") || a.keyword.localeCompare(b.keyword, "ja"));
  if (liveRows.length) return liveRows;
  try {
    const envTargets = process.env.RPP_CONFIGURED_TARGETS_JSON;
    if (envTargets) {
      const snapshot = JSON.parse(envTargets) as { targets?: RppConfiguredTarget[] } | RppConfiguredTarget[];
      const rows = Array.isArray(snapshot) ? snapshot : snapshot.targets ?? [];
      return rows
        .filter((row) => !exclusionOverrides[row.itemCode.trim().toLowerCase()])
        .sort((a, b) => a.itemCode.localeCompare(b.itemCode, "ja") || a.keyword.localeCompare(b.keyword, "ja"));
    }
    const snapshot = JSON.parse(await fs.readFile(SNAPSHOT_TARGETS_PATH, "utf8")) as { targets?: RppConfiguredTarget[] };
    return (snapshot.targets ?? [])
      .filter((row) => !exclusionOverrides[row.itemCode.trim().toLowerCase()])
      .sort((a, b) => a.itemCode.localeCompare(b.itemCode, "ja") || a.keyword.localeCompare(b.keyword, "ja"));
  } catch {
    return [];
  }
}

export async function readRppExclusionProducts(): Promise<RppExclusionProduct[]> {
  const [itemRows, ownerMap, exclusionOverrides] = await Promise.all([readCsv(ITEM_SETTINGS_PATH), readOwnerMap(), readRppExclusionOverrides()]);
  const liveRows: RppExclusionProduct[] = [];
  for (const row of itemRows) {
    const itemCode = cleanText(row["商品管理番号"]).toLowerCase();
    const itemCpc = optionalNumber(row["商品CPC"]);
    if (!itemCode || !itemCpc) continue;
    liveRows.push({
      itemCode,
      itemName: cleanText(row["商品名"]),
      itemCpc,
      excluded: exclusionOverrides[itemCode] ?? (cleanText(row["除外登録済み商品"]).toLowerCase() === "yes"),
      owner: ownerMap[itemCode] || "担当未設定",
    });
  }
  liveRows.sort((a, b) => a.itemCode.localeCompare(b.itemCode, "ja"));
  if (liveRows.length) return liveRows;
  try {
    const envProducts = process.env.RPP_EXCLUSION_PRODUCTS_JSON;
    if (envProducts) {
      const snapshot = JSON.parse(envProducts) as { products?: RppExclusionProduct[] } | RppExclusionProduct[];
      const rows = Array.isArray(snapshot) ? snapshot : snapshot.products ?? [];
      return rows.map((row) => ({ ...row, excluded: exclusionOverrides[row.itemCode.toLowerCase()] ?? row.excluded })).sort((a, b) => a.itemCode.localeCompare(b.itemCode, "ja"));
    }
    const snapshot = JSON.parse(await fs.readFile(SNAPSHOT_EXCLUSION_PRODUCTS_PATH, "utf8")) as { products?: RppExclusionProduct[] };
    return (snapshot.products ?? []).map((row) => ({ ...row, excluded: exclusionOverrides[row.itemCode.toLowerCase()] ?? row.excluded })).sort((a, b) => a.itemCode.localeCompare(b.itemCode, "ja"));
  } catch {
    return [];
  }
}

export async function readRppAlertTargets() {
  const [targets, configuredTargets, exclusionProducts] = await Promise.all([readRawTargets(), readRppConfiguredTargets(), readRppExclusionProducts()]);
  const savedIds = new Set(targets.map((row) => row.id));
  return {
    filePath: TARGETS_PATH,
    source: pool ? `db:${TARGETS_TABLE}` : `fallback:${TARGETS_PATH}`,
    targets,
    configuredTargets,
    configuredCount: configuredTargets.length,
    missingTargetCount: configuredTargets.filter((row) => !savedIds.has(row.id)).length,
    exclusionProducts,
    exclusionCounts: {
      total: exclusionProducts.length,
      active: exclusionProducts.filter((row) => !row.excluded).length,
      excluded: exclusionProducts.filter((row) => row.excluded).length,
    },
  };
}

export async function upsertRppAlertTarget(input: RppAlertTargetInput) {
  const normalized = normalizeInput(input);
  const now = new Date().toISOString();
  const id = targetId(normalized.itemCode, normalized.keyword);
  const targets = await readRawTargets();
  const idx = targets.findIndex((row) => row.id === id);
  const next: RppAlertTarget = {
    ...(idx >= 0 ? targets[idx] : { id, createdAt: now }),
    ...normalized,
    id,
    updatedAt: now,
  };
  if (idx >= 0) targets[idx] = next;
  else targets.push(next);
  await upsertRawTarget(next);
  return next;
}

export async function deleteRppAlertTarget(id: string) {
  const deleted = await deleteRawTarget(id);
  if (!deleted) throw new Error(`目標設定が見つかりません: ${id}`);
  return { id, deleted: true };
}

export async function seedMissingRppAlertTargets(defaults: Partial<RppAlertTargetInput> = {}) {
  const configured = await readRppConfiguredTargets();
  const targets = await readRawTargets();
  const existing = new Set(targets.map((row) => row.id));
  const now = new Date().toISOString();
  const additions: RppAlertTarget[] = [];
  for (const row of configured) {
    if (existing.has(row.id)) continue;
    const normalized = normalizeInput({
      itemCode: row.itemCode,
      keyword: row.keyword,
      owner: row.owner,
      searchKeywords: row.keyword === "商品CPC" ? (row.rppPositionKeyword ? row.rppPositionKeyword.replace("（代表KW）", "") : undefined) : row.keyword,
      changeLocked: false,
      lockReason: "",
      ...defaults,
    });
    additions.push({ id: row.id, ...normalized, createdAt: now, updatedAt: now });
  }
  for (const target of additions) await upsertRawTarget(target);
  return { added: additions.length, totalConfigured: configured.length };
}

export function positionGoalLabel(goal: RppPositionGoal) {
  if (goal === "TOP_3") return "RPP広告3位以内";
  if (goal === "TOP_5") return "RPP広告5位以内";
  if (goal === "TOP_7") return "RPP広告7位以内";
  return "RPP広告1ページ目内";
}
