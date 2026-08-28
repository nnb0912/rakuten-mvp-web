import { promises as fs } from "fs";
import path from "path";

const DEFAULT_RPP_PROJECT_DIR = "/Users/nob/Projects/rpp-8am-notify";
const RPP_PROJECT_DIR = process.env.RPP_PROJECT_DIR ?? (process.platform === "darwin" ? DEFAULT_RPP_PROJECT_DIR : "/tmp/rpp-8am-notify");
const SETTINGS_DIR = path.join(RPP_PROJECT_DIR, "rpp_targets");
const SETTINGS_PATH = path.join(SETTINGS_DIR, "rpp_auto_adjustment_settings.json");

export type RppAutoAdjustmentSettings = {
  enabled: boolean;
  itemEnabledDefault: boolean;
  keywordEnabledDefault: boolean;
  floorCpc: number;
  itemCpcMax: number;
  keywordCpcMax: number;
  maxRaisePerDay: number;
  maxLowerPerDay: number;
  roasFloor: number;
  onlyRaiseWhenPageOut: boolean;
  excludeChangeLocked: boolean;
  excludeRmsExcluded: boolean;
  updatedAt: string | null;
};

export type RppAutoAdjustmentSettingsInput = Partial<Omit<RppAutoAdjustmentSettings, "updatedAt">>;

export const DEFAULT_RPP_AUTO_ADJUSTMENT_SETTINGS: RppAutoAdjustmentSettings = {
  enabled: false,
  itemEnabledDefault: false,
  keywordEnabledDefault: true,
  floorCpc: 40,
  itemCpcMax: 120,
  keywordCpcMax: 120,
  maxRaisePerDay: 20,
  maxLowerPerDay: 10,
  roasFloor: 500,
  onlyRaiseWhenPageOut: true,
  excludeChangeLocked: true,
  excludeRmsExcluded: true,
  updatedAt: null,
};

function boolValue(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function numValue(value: unknown, fallback: number, min = 0) {
  if (value == null || String(value).trim() === "") return fallback;
  const n = Number(String(value).replace(/,/g, "").trim());
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.round(n);
}

export function normalizeRppAutoAdjustmentSettings(input: RppAutoAdjustmentSettingsInput & { updatedAt?: string | null } = {}): RppAutoAdjustmentSettings {
  const base = DEFAULT_RPP_AUTO_ADJUSTMENT_SETTINGS;
  return {
    enabled: boolValue(input.enabled, base.enabled),
    itemEnabledDefault: boolValue(input.itemEnabledDefault, base.itemEnabledDefault),
    keywordEnabledDefault: boolValue(input.keywordEnabledDefault, base.keywordEnabledDefault),
    floorCpc: numValue(input.floorCpc, base.floorCpc, 1),
    itemCpcMax: numValue(input.itemCpcMax, base.itemCpcMax, 1),
    keywordCpcMax: numValue(input.keywordCpcMax, base.keywordCpcMax, 1),
    maxRaisePerDay: numValue(input.maxRaisePerDay, base.maxRaisePerDay, 0),
    maxLowerPerDay: numValue(input.maxLowerPerDay, base.maxLowerPerDay, 0),
    roasFloor: numValue(input.roasFloor, base.roasFloor, 0),
    onlyRaiseWhenPageOut: boolValue(input.onlyRaiseWhenPageOut, base.onlyRaiseWhenPageOut),
    excludeChangeLocked: boolValue(input.excludeChangeLocked, base.excludeChangeLocked),
    excludeRmsExcluded: boolValue(input.excludeRmsExcluded, base.excludeRmsExcluded),
    updatedAt: input.updatedAt ?? null,
  };
}

export async function readRppAutoAdjustmentSettings() {
  try {
    const raw = JSON.parse(await fs.readFile(SETTINGS_PATH, "utf8")) as RppAutoAdjustmentSettingsInput & { updatedAt?: string | null };
    return { source: SETTINGS_PATH, settings: normalizeRppAutoAdjustmentSettings(raw) };
  } catch {
    return { source: SETTINGS_PATH, settings: DEFAULT_RPP_AUTO_ADJUSTMENT_SETTINGS };
  }
}

export async function writeRppAutoAdjustmentSettings(input: RppAutoAdjustmentSettingsInput) {
  const settings = normalizeRppAutoAdjustmentSettings({ ...input, updatedAt: new Date().toISOString() });
  if (settings.floorCpc > settings.itemCpcMax) throw new Error("最低CPCは商品CPC上限以下にしてください");
  if (settings.floorCpc > settings.keywordCpcMax) throw new Error("最低CPCはキーワードCPC上限以下にしてください");
  await fs.mkdir(SETTINGS_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return { source: SETTINGS_PATH, settings };
}
