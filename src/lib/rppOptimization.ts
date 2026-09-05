export type RppRoutineOptimizationMode = "ROAS" | "POSITION" | "BALANCED" | "FIXED";
export type RppOptimizationMode = RppRoutineOptimizationMode;
export type RppCpcKind = "ITEM" | "KEYWORD";
export type RppProtectionType = "NORMAL" | "BLOCK" | "WHITELIST" | "LOCKED" | "FOCUS";

export const ROUTINE_OPTIMIZATION_MODES = [
  { value: "ROAS", label: "ROASモード", description: "利益効率を基準にCPCを調整" },
  { value: "POSITION", label: "検索順位モード", description: "PC/SPの検索順位提案を採用" },
  { value: "BALANCED", label: "バランスモード", description: "ROASを守りながら検索順位を調整" },
  { value: "FIXED", label: "CPC固定モード", description: "RMSと同様に指定CPCを維持" },
] as const satisfies ReadonlyArray<{ value: RppRoutineOptimizationMode; label: string; description: string }>;

const OPTIMIZATION_MODES: readonly RppOptimizationMode[] = ROUTINE_OPTIMIZATION_MODES.map(({ value }) => value);

export function normalizeRppOptimizationMode(value: unknown): RppOptimizationMode {
  return OPTIMIZATION_MODES.includes(value as RppOptimizationMode) ? value as RppOptimizationMode : "ROAS";
}

export function optimizationModeLabel(mode: RppOptimizationMode) {
  return ROUTINE_OPTIMIZATION_MODES.find((option) => option.value === mode)?.label ?? "ROASモード";
}


export type RppModeCpcBounds = {
  roasMinCpc?: number | null;
  roasMaxCpc?: number | null;
  positionMinCpc?: number | null;
  positionMaxCpc?: number | null;
  balancedMinCpc?: number | null;
  balancedMaxCpc?: number | null;
};

function finitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function validateRppModeCpcBounds(bounds: RppModeCpcBounds) {
  const pairs = [
    ["ROASモード", bounds.roasMinCpc, bounds.roasMaxCpc],
    ["検索順位モード", bounds.positionMinCpc, bounds.positionMaxCpc],
    ["バランスモード", bounds.balancedMinCpc, bounds.balancedMaxCpc],
  ] as const;
  for (const [label, minimum, maximum] of pairs) {
    if (finitePositive(minimum) && finitePositive(maximum) && minimum > maximum) {
      throw new Error(`${label}のCPC下限は上限以下にしてください`);
    }
  }
  return bounds;
}

export type RppOptimizationInput = RppModeCpcBounds & {
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

function floorFor(kind: RppCpcKind) {
  return kind === "KEYWORD" ? KEYWORD_CPC_FLOOR : ITEM_CPC_FLOOR;
}

function clampProposalWithBounds(value: number, currentCpc: number, kind: RppCpcKind, minCpc?: number | null, maxCpc?: number | null, focus = false) {
  const floor = floorFor(kind);
  const safeMinimum = Math.max(floor, currentCpc * MAX_LOWER_RATE, finitePositive(minCpc) ? minCpc : 0);
  const safeMaximum = currentCpc * (focus ? 1.5 : MAX_RAISE_RATE);
  const withChangeLimit = Math.min(Math.max(value, safeMinimum), safeMaximum);
  const withManualCap = finitePositive(maxCpc) ? Math.min(withChangeLimit, maxCpc) : withChangeLimit;
  return Math.max(floor, Math.round(withManualCap));
}

function clampProposal(value: number, currentCpc: number, kind: RppCpcKind, maxCpc?: number | null, focus = false) {
  return clampProposalWithBounds(value, currentCpc, kind, null, maxCpc, focus);
}

function selectedModeBounds(input: RppOptimizationInput) {
  if (input.mode === "ROAS") return { minCpc: input.roasMinCpc, maxCpc: input.roasMaxCpc ?? input.maxCpc };
  if (input.mode === "POSITION") return { minCpc: input.positionMinCpc, maxCpc: input.positionMaxCpc ?? input.maxCpc };
  if (input.mode === "BALANCED") return { minCpc: input.balancedMinCpc, maxCpc: input.balancedMaxCpc ?? input.maxCpc };
  return { minCpc: null, maxCpc: input.maxCpc };
}

export function calculateRoasCpc(currentCpc: number, actualRoas: number, targetRoas: number, kind: RppCpcKind, maxCpc?: number | null, focus = false) {
  if (!finitePositive(currentCpc) || !finitePositive(actualRoas) || !finitePositive(targetRoas)) return null;
  const ratio = actualRoas / targetRoas;
  const raw = ratio < 1
    ? currentCpc * ratio
    : currentCpc * (1 + (ratio - 1) * 0.5);
  return clampProposal(raw, currentCpc, kind, maxCpc, focus);
}

export function calculateBalancedCpc(
  currentCpc: number,
  actualRoas: number,
  targetRoas: number,
  positionSuggestedCpc: number,
  kind: RppCpcKind,
  focus = false,
) {
  if (![currentCpc, actualRoas, targetRoas, positionSuggestedCpc].every(finitePositive)) return null;
  const roasCandidate = calculateRoasCpc(currentCpc, actualRoas, targetRoas, kind, null, focus);
  const positionCandidate = clampProposal(positionSuggestedCpc, currentCpc, kind, null, focus);
  if (roasCandidate == null) return null;

  if (actualRoas < targetRoas) return Math.min(roasCandidate, positionCandidate);
  if (positionSuggestedCpc > currentCpc) return Math.min(positionCandidate, roasCandidate);
  return positionCandidate;
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
  const focus = input.protectionType === "FOCUS";
  const bounds = selectedModeBounds(input);
  validateRppModeCpcBounds(input);
  let proposedCpc: number | null = null;
  if (input.mode === "ROAS") {
    if (!finitePositive(input.actualRoas) || !finitePositive(input.targetRoas)) return blocked("ROAS実績または目標不足");
    const candidate = calculateRoasCpc(currentCpc, input.actualRoas, input.targetRoas, input.cpcKind, null, focus);
    proposedCpc = candidate == null ? null : clampProposalWithBounds(candidate, currentCpc, input.cpcKind, bounds.minCpc, bounds.maxCpc, focus);
  } else if (input.mode === "POSITION") {
    if (!finitePositive(input.positionSuggestedCpc)) return blocked("検索順位ベース提案なし");
    proposedCpc = clampProposalWithBounds(input.positionSuggestedCpc, currentCpc, input.cpcKind, bounds.minCpc, bounds.maxCpc, focus);
  } else if (input.mode === "BALANCED") {
    if (!finitePositive(input.actualRoas) || !finitePositive(input.targetRoas) || !finitePositive(input.positionSuggestedCpc)) {
      return blocked("ROAS実績・目標または検索順位ベース提案不足");
    }
    const candidate = calculateBalancedCpc(currentCpc, input.actualRoas, input.targetRoas, input.positionSuggestedCpc, input.cpcKind, focus);
    proposedCpc = candidate == null ? null : clampProposalWithBounds(candidate, currentCpc, input.cpcKind, bounds.minCpc, bounds.maxCpc, focus);
  } else {
    if (!finitePositive(input.fixedCpc)) return blocked("固定CPC未設定");
    proposedCpc = Math.max(floorFor(input.cpcKind), Math.round(input.fixedCpc));
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
