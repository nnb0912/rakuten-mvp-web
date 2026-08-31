export type RppOptimizationMode = "ROAS" | "POSITION" | "FIXED";
export type RppCpcKind = "ITEM" | "KEYWORD";
export type RppProtectionType = "NORMAL" | "BLOCK" | "WHITELIST" | "LOCKED" | "FOCUS";

export type RppOptimizationInput = {
  mode: RppOptimizationMode;
  cpcKind: RppCpcKind;
  currentCpc: number | null;
  actualRoas: number | null;
  targetRoas: number;
  spend: number | null;
  sales: number | null;
  positionSuggestedCpc?: number | null;
  fixedCpc?: number | null;
  maxCpc?: number | null;
  changeLocked?: boolean;
  protectionType?: RppProtectionType;
  experimentEndDate?: string;
  today?: string;
};

export type RppOptimizationPreview = {
  mode: RppOptimizationMode;
  currentCpc: number;
  proposedCpc: number | null;
  delta: number | null;
  projectedSpend: number | null;
  projectedRoas: number | null;
  savings: number | null;
  blockedReason: string | null;
};

export const ITEM_CPC_FLOOR = 20;
export const KEYWORD_CPC_FLOOR = 40;
export const MAX_RAISE_RATE = 1.2;
export const MAX_LOWER_RATE = 0.5;

function finitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function floorFor(kind: RppCpcKind) {
  return kind === "KEYWORD" ? KEYWORD_CPC_FLOOR : ITEM_CPC_FLOOR;
}

function clampProposal(value: number, currentCpc: number, kind: RppCpcKind, maxCpc?: number | null, focus = false) {
  const floor = floorFor(kind);
  const safeMinimum = Math.max(floor, currentCpc * MAX_LOWER_RATE);
  const safeMaximum = currentCpc * (focus ? 1.5 : MAX_RAISE_RATE);
  const withChangeLimit = Math.min(Math.max(value, safeMinimum), safeMaximum);
  const withManualCap = finitePositive(maxCpc) ? Math.min(withChangeLimit, maxCpc) : withChangeLimit;
  return Math.max(floor, Math.round(withManualCap));
}

export function calculateRoasCpc(currentCpc: number, actualRoas: number, targetRoas: number, kind: RppCpcKind, maxCpc?: number | null, focus = false) {
  if (!finitePositive(currentCpc) || !finitePositive(actualRoas) || !finitePositive(targetRoas)) return null;
  const ratio = actualRoas / targetRoas;
  const raw = ratio < 1
    ? currentCpc * ratio
    : currentCpc * (1 + (ratio - 1) * 0.5);
  return clampProposal(raw, currentCpc, kind, maxCpc, focus);
}

export function buildRppOptimizationPreview(input: RppOptimizationInput): RppOptimizationPreview {
  const currentCpc = finitePositive(input.currentCpc) ? input.currentCpc : 0;
  const blocked = (reason: string): RppOptimizationPreview => ({
    mode: input.mode,
    currentCpc,
    proposedCpc: null,
    delta: null,
    projectedSpend: null,
    projectedRoas: null,
    savings: null,
    blockedReason: reason,
  });

  if (input.changeLocked || input.protectionType === "LOCKED") return blocked("変更不可リスト");
  if (input.protectionType === "BLOCK") return blocked("ブロック対象");
  if (!currentCpc) return blocked("現在CPCなし");
  const today = input.today || new Date().toISOString().slice(0, 10);
  if (input.mode !== "ROAS" && input.experimentEndDate && input.experimentEndDate < today) return blocked("実験期間終了");

  let proposedCpc: number | null = null;
  if (input.mode === "ROAS") {
    if (!finitePositive(input.actualRoas) || !finitePositive(input.targetRoas)) return blocked("ROAS実績または目標不足");
    proposedCpc = calculateRoasCpc(currentCpc, input.actualRoas, input.targetRoas, input.cpcKind, input.maxCpc, input.protectionType === "FOCUS");
  } else if (input.mode === "POSITION") {
    if (!finitePositive(input.positionSuggestedCpc)) return blocked("検索順位ベース提案なし");
    proposedCpc = clampProposal(input.positionSuggestedCpc, currentCpc, input.cpcKind, input.maxCpc, input.protectionType === "FOCUS");
  } else {
    if (!finitePositive(input.fixedCpc)) return blocked("固定CPC未設定");
    proposedCpc = clampProposal(input.fixedCpc, currentCpc, input.cpcKind, input.maxCpc, input.protectionType === "FOCUS");
  }

  if (!proposedCpc) return blocked("提案を計算できません");
  const spend = finitePositive(input.spend) ? input.spend : null;
  const sales = typeof input.sales === "number" && Number.isFinite(input.sales) && input.sales >= 0 ? input.sales : null;
  const projectedSpend = spend == null ? null : spend * (proposedCpc / currentCpc);
  const projectedRoas = projectedSpend && sales != null ? (sales / projectedSpend) * 100 : null;
  const savings = spend == null || projectedSpend == null ? null : spend - projectedSpend;

  return {
    mode: input.mode,
    currentCpc,
    proposedCpc,
    delta: proposedCpc - currentCpc,
    projectedSpend,
    projectedRoas,
    savings,
    blockedReason: null,
  };
}
