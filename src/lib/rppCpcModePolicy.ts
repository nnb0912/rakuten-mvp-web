import type { RppOptimizationMode } from "./rppOptimization";

export const RPP_AUTO_CPC_ITEM_CODES = ["r0445", "r0406"] as const;

export function isRppAutoCpcItem(itemCode: string) {
  return RPP_AUTO_CPC_ITEM_CODES.includes(itemCode.trim().toLowerCase() as (typeof RPP_AUTO_CPC_ITEM_CODES)[number]);
}

export function effectiveRppOptimizationMode(itemCode: string, requestedMode: RppOptimizationMode): RppOptimizationMode {
  return isRppAutoCpcItem(itemCode) ? requestedMode : "FIXED";
}

export function assertRppOptimizationModeAllowed(itemCode: string, mode: RppOptimizationMode) {
  if (!isRppAutoCpcItem(itemCode) && mode !== "FIXED") {
    throw new Error("R0445・R0406以外はCPC固定モードで設定してください");
  }
}

export function canDownloadManualCpcCsv(itemCode: string) {
  return !isRppAutoCpcItem(itemCode);
}