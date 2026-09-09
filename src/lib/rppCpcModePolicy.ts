import type { RppOptimizationMode } from "./rppOptimization";

export function isAutomaticRppOptimizationMode(mode: RppOptimizationMode) {
  return mode !== "FIXED";
}

export function canDownloadManualCpcCsv(mode: RppOptimizationMode) {
  return mode === "FIXED";
}
