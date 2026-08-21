import { promises as fs } from "fs";
import path from "path";
import configuredTargetsSnapshot from "@/data/rpp_configured_targets.json";

export type RppPositionGoal = "FIRST_PAGE" | "TOP_5" | "TOP_3";
export type RppOperationPolicy = "攻め" | "維持" | "テスト" | "停止候補";

export type RppAlertTarget = {
  id: string;
  itemCode: string;
  keyword: string;
  owner: string;
  ctrGoal: number;
  cvrGoal: number;
  roasFloor: number;
  positionGoal: RppPositionGoal;
  policy: RppOperationPolicy;
  note: string;
  searchKeywords: string[];
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
  policy?: RppOperationPolicy;
  note?: string;
  searchKeywords?: string[] | string;
};

const DEFAULT_RPP_PROJECT_DIR = "/Users/nob/Projects/rpp-8am-notify";
const RPP_PROJECT_DIR = process.env.RPP_PROJECT_DIR ?? (process.platform === "darwin" ? DEFAULT_RPP_PROJECT_DIR : "/tmp/rpp-8am-notify");
const DATA_DIR = path.join(RPP_PROJECT_DIR, "rpp_targets");
const TARGETS_PATH = path.join(DATA_DIR, "rpp_alert_targets.json");
const ITEM_SETTINGS_PATH = path.join(RPP_PROJECT_DIR, "rpp_item_settings.csv");
const KEYWORD_SETTINGS_PATH = path.join(RPP_PROJECT_DIR, "rpp_keyword_settings.csv");
const SNAPSHOT_TARGETS_PATH = path.join(process.cwd(), "src", "data", "rpp_configured_targets.json");
const SNAPSHOT_EXCLUSION_PRODUCTS_PATH = path.join(process.cwd(), "src", "data", "rpp_exclusion_products.json");
const SNAPSHOT_OWNER_MAP_PATH = path.join(process.cwd(), "src", "data", "rpp_owner_map.json");

const POSITION_GOALS: RppPositionGoal[] = ["FIRST_PAGE", "TOP_5", "TOP_3"];
const POLICIES: RppOperationPolicy[] = ["攻め", "維持", "テスト", "停止候補"];

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
  const policy = POLICIES.includes(input.policy as RppOperationPolicy) ? input.policy as RppOperationPolicy : "維持";
  return {
    itemCode,
    keyword,
    owner: cleanText(input.owner),
    ctrGoal: finiteNumber(input.ctrGoal, 5),
    cvrGoal: finiteNumber(input.cvrGoal, 5),
    roasFloor: finiteNumber(input.roasFloor, 500),
    positionGoal,
    policy,
    note: cleanText(input.note),
    searchKeywords,
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
  try {
    const raw = JSON.parse(await fs.readFile(TARGETS_PATH, "utf8")) as unknown;
    if (Array.isArray(raw)) return raw as RppAlertTarget[];
    if (raw && typeof raw === "object" && Array.isArray((raw as { targets?: unknown }).targets)) {
      return (raw as { targets: RppAlertTarget[] }).targets;
    }
  } catch {}
  return [];
}

async function writeRawTargets(targets: RppAlertTarget[]) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload = {
    updatedAt: new Date().toISOString(),
    targets: targets.sort((a, b) => a.itemCode.localeCompare(b.itemCode, "ja") || a.keyword.localeCompare(b.keyword, "ja")),
  };
  await fs.writeFile(TARGETS_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function readRppConfiguredTargets() {
  const [itemRows, ownerMap, positionMap] = await Promise.all([readCsv(ITEM_SETTINGS_PATH), readOwnerMap(), readConfiguredPositionMap()]);
  const activeItems = new Map<string, { itemName: string; itemCpc: number | null; owner: string }>();
  for (const row of itemRows) {
    const itemCode = cleanText(row["商品管理番号"]).toLowerCase();
    const itemCpc = optionalNumber(row["商品CPC"]);
    const excluded = cleanText(row["除外登録済み商品"]).toLowerCase() === "yes";
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
      return rows.sort((a, b) => a.itemCode.localeCompare(b.itemCode, "ja") || a.keyword.localeCompare(b.keyword, "ja"));
    }
    const snapshot = JSON.parse(await fs.readFile(SNAPSHOT_TARGETS_PATH, "utf8")) as { targets?: RppConfiguredTarget[] };
    return (snapshot.targets ?? []).sort((a, b) => a.itemCode.localeCompare(b.itemCode, "ja") || a.keyword.localeCompare(b.keyword, "ja"));
  } catch {
    return [];
  }
}

export async function readRppExclusionProducts(): Promise<RppExclusionProduct[]> {
  const [itemRows, ownerMap] = await Promise.all([readCsv(ITEM_SETTINGS_PATH), readOwnerMap()]);
  const liveRows: RppExclusionProduct[] = [];
  for (const row of itemRows) {
    const itemCode = cleanText(row["商品管理番号"]).toLowerCase();
    const itemCpc = optionalNumber(row["商品CPC"]);
    if (!itemCode || !itemCpc) continue;
    liveRows.push({
      itemCode,
      itemName: cleanText(row["商品名"]),
      itemCpc,
      excluded: cleanText(row["除外登録済み商品"]).toLowerCase() === "yes",
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
      return rows.sort((a, b) => a.itemCode.localeCompare(b.itemCode, "ja"));
    }
    const snapshot = JSON.parse(await fs.readFile(SNAPSHOT_EXCLUSION_PRODUCTS_PATH, "utf8")) as { products?: RppExclusionProduct[] };
    return (snapshot.products ?? []).sort((a, b) => a.itemCode.localeCompare(b.itemCode, "ja"));
  } catch {
    return [];
  }
}

export async function readRppAlertTargets() {
  const [targets, configuredTargets, exclusionProducts] = await Promise.all([readRawTargets(), readRppConfiguredTargets(), readRppExclusionProducts()]);
  const savedIds = new Set(targets.map((row) => row.id));
  return {
    filePath: TARGETS_PATH,
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
  await writeRawTargets(targets);
  return next;
}

export async function deleteRppAlertTarget(id: string) {
  const targets = await readRawTargets();
  const next = targets.filter((row) => row.id !== id && decodeURIComponent(row.id) !== id);
  if (next.length === targets.length) throw new Error(`目標設定が見つかりません: ${id}`);
  await writeRawTargets(next);
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
      ...defaults,
    });
    additions.push({ id: row.id, ...normalized, createdAt: now, updatedAt: now });
  }
  if (additions.length) await writeRawTargets([...targets, ...additions]);
  return { added: additions.length, totalConfigured: configured.length };
}

export function positionGoalLabel(goal: RppPositionGoal) {
  if (goal === "TOP_3") return "RPP広告3位以内";
  if (goal === "TOP_5") return "RPP広告5位以内";
  return "RPP広告1ページ目内";
}
