export type RppAnomalyType = "CPC_SPIKE" | "ROAS_DROP" | "SPEND_SPIKE" | "DATA_MISSING" | "DATA_STALE" | "COUNT_MISMATCH";
export type RppAnomaly = { type: RppAnomalyType; severity: "WARNING" | "CRITICAL"; label: string; detail: string };
export type RppAnomalySnapshot = { cpc: number | null; roas: number | null; spend: number | null; observedAt?: string | null; rowCount: number; requiredFieldsPresent?: boolean };

const anomalyOrder: RppAnomalyType[] = ["CPC_SPIKE", "ROAS_DROP", "SPEND_SPIKE", "DATA_MISSING", "DATA_STALE", "COUNT_MISMATCH"];
const finiteNonNegative = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const pct = (rate: number) => `${Math.round(rate * 100)}%`;

export function detectRppAnomalies(input: {
  current: RppAnomalySnapshot;
  previous: Omit<RppAnomalySnapshot, "observedAt" | "requiredFieldsPresent">;
  now?: string;
  thresholds?: Partial<{ cpcRiseRate: number; roasDropRate: number; spendRiseRate: number; staleHours: number }>;
}): RppAnomaly[] {
  const threshold = { cpcRiseRate: 0.5, roasDropRate: 0.4, spendRiseRate: 1, staleHours: 36, ...input.thresholds };
  const anomalies: RppAnomaly[] = [];
  const add = (type: RppAnomalyType, severity: RppAnomaly["severity"], label: string, detail: string) => anomalies.push({ type, severity, label, detail });
  if (finiteNonNegative(input.current.cpc) && finiteNonNegative(input.previous.cpc) && input.previous.cpc > 0) {
    const rate = input.current.cpc / input.previous.cpc - 1;
    if (rate >= threshold.cpcRiseRate) add("CPC_SPIKE", "WARNING", "CPC急騰", `${Math.round(input.previous.cpc)}円→${Math.round(input.current.cpc)}円（+${pct(rate)}）`);
  }
  if (finiteNonNegative(input.current.roas) && finiteNonNegative(input.previous.roas) && input.previous.roas > 0) {
    const rate = 1 - input.current.roas / input.previous.roas;
    if (rate >= threshold.roasDropRate) add("ROAS_DROP", "CRITICAL", "ROAS急落", `${Math.round(input.previous.roas)}%→${Math.round(input.current.roas)}%（-${pct(rate)}）`);
  }
  if (finiteNonNegative(input.current.spend) && finiteNonNegative(input.previous.spend) && input.previous.spend > 0) {
    const rate = input.current.spend / input.previous.spend - 1;
    if (rate >= threshold.spendRiseRate) add("SPEND_SPIKE", "CRITICAL", "広告費急増", `${Math.round(input.previous.spend).toLocaleString("ja-JP")}円→${Math.round(input.current.spend).toLocaleString("ja-JP")}円（+${pct(rate)}）`);
  }
  const requiredMissing = input.current.requiredFieldsPresent === false || !finiteNonNegative(input.current.cpc) || !finiteNonNegative(input.current.roas) || !finiteNonNegative(input.current.spend);
  if (requiredMissing) add("DATA_MISSING", "CRITICAL", "データ欠損", "CPC・ROAS・広告費の必須値を確認してください");
  const observedAt = input.current.observedAt ? new Date(input.current.observedAt).getTime() : Number.NaN;
  const now = new Date(input.now ?? new Date().toISOString()).getTime();
  const ageHours = (now - observedAt) / 36e5;
  if (!Number.isFinite(ageHours) || ageHours > threshold.staleHours) add("DATA_STALE", "CRITICAL", "データ鮮度NG", Number.isFinite(ageHours) ? `${ageHours.toFixed(1)}時間経過（上限${threshold.staleHours}時間）` : "観測日時なし");
  if (input.current.rowCount !== input.previous.rowCount) add("COUNT_MISMATCH", "WARNING", "件数不一致", `前回${input.previous.rowCount}件 / 今回${input.current.rowCount}件`);
  return anomalies.sort((a, b) => anomalyOrder.indexOf(a.type) - anomalyOrder.indexOf(b.type));
}

export function evaluateChatworkDelivery(input: { requestedSend: boolean; sendEnabled: boolean; tokenPresent: boolean; roomPresent: boolean }) {
  if (!input.requestedSend) return { mode: "DRY_RUN" as const, canSend: false, reason: "Dry Run（既定）" };
  if (!input.sendEnabled) return { mode: "BLOCKED" as const, canSend: false, reason: "RPP_CHATWORK_SEND_ENABLED=true が必要です" };
  if (!input.tokenPresent || !input.roomPresent) return { mode: "BLOCKED" as const, canSend: false, reason: "Chatwork token/room未設定" };
  return { mode: "SEND" as const, canSend: true, reason: null };
}

export function formatRppAnomalyMessage(anomalies: RppAnomaly[], generatedAt = new Date().toISOString()) {
  const lines = anomalies.length ? anomalies.map((row) => `・[${row.severity}] ${row.label}: ${row.detail}`) : ["・異常なし"];
  return `[info][title]RPP異常検知 ${anomalies.length}件[/title]判定日時: ${generatedAt}\n${lines.join("\n")}\nRMS変更: なし[/info]`;
}
