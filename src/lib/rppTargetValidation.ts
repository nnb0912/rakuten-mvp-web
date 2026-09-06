export type RppTargetValidationInput = {
  optimizationMode?: unknown;
  positionGoal?: unknown;
  pcPositionGoal?: unknown;
  spPositionGoal?: unknown;
  ctrGoal?: unknown;
  cvrGoal?: unknown;
  roasFloor?: unknown;
  fixedCpc?: unknown;
  maxCpc?: unknown;
  roasMinCpc?: unknown;
  roasMaxCpc?: unknown;
  positionMinCpc?: unknown;
  positionMaxCpc?: unknown;
  balancedMinCpc?: unknown;
  balancedMaxCpc?: unknown;
};

export function validateRppTargetInputValues(input: RppTargetValidationInput) {
  const modes = ["ROAS", "POSITION", "BALANCED", "FIXED"];
  const goals = ["FIRST_PAGE", "TOP_7", "TOP_5", "TOP_3"];
  if (input.optimizationMode != null && !modes.includes(String(input.optimizationMode))) throw new Error("運用モードが不正です");
  for (const [label, value] of [["順位目標", input.positionGoal], ["PC順位目標", input.pcPositionGoal], ["SP順位目標", input.spPositionGoal]] as const) {
    if (value != null && !goals.includes(String(value))) throw new Error(`${label}が不正です`);
  }
  if (input.pcPositionGoal === "TOP_7") throw new Error("PC順位目標に7位以内は指定できません");
  for (const [label, raw] of Object.entries({ maxCpc: input.maxCpc, fixedCpc: input.fixedCpc, roasMinCpc: input.roasMinCpc, roasMaxCpc: input.roasMaxCpc, positionMinCpc: input.positionMinCpc, positionMaxCpc: input.positionMaxCpc, balancedMinCpc: input.balancedMinCpc, balancedMaxCpc: input.balancedMaxCpc })) {
    if (raw == null || String(raw).trim() === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${label}は正数で入力してください`);
  }
  for (const [label, raw, allowZero] of [["CTR", input.ctrGoal, true], ["CVR", input.cvrGoal, true], ["ROAS", input.roasFloor, false]] as const) {
    if (raw == null || String(raw).trim() === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) throw new Error(`${label}目標を有効な正数で入力してください`);
  }
  if (input.optimizationMode === "FIXED" && !(Number(input.fixedCpc) > 0)) throw new Error("CPC固定モードでは固定CPCが必須です");
}
