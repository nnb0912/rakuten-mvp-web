import { promises as fs } from "fs";
import path from "path";
import { readRecentRppDashboardSnapshots, type RppDashboardSnapshot } from "./rppDashboardSnapshots.ts";
import { detectRppAnomalies, type RppAnomaly, type RppAnomalySnapshot } from "./rppAnomalyAlerts.ts";

type RecommendationPayload = { summary?: Record<string, unknown>; recommendations?: Record<string, unknown>[] };
export type RppAnomalyComparison = {
  current: RppAnomalySnapshot | null;
  previous: Omit<RppAnomalySnapshot, "observedAt" | "requiredFieldsPresent"> | null;
  anomalies: RppAnomaly[];
  currentSource: string | null;
  previousSource: string | null;
  comparisonReady: boolean;
};

const PROJECT_DIR = process.env.RPP_PROJECT_DIR ?? (process.platform === "darwin" ? "/Users/nob/Projects/rpp-8am-notify" : "/tmp/rpp-8am-notify");
const RECOMMENDATION_DIR = path.join(PROJECT_DIR, "rpp_recommendations");
const STATIC_SNAPSHOT = path.join(process.cwd(), "src", "data", "rpp_recommendations_snapshot.json");
const numberOrNull = (value: unknown) => value == null || !Number.isFinite(Number(value)) ? null : Number(value);

export function aggregateRppAnomalySnapshot(payload: RecommendationPayload, fallbackObservedAt?: string | null): RppAnomalySnapshot {
  const rows = Array.isArray(payload.recommendations) ? payload.recommendations : [];
  let spend = 0;
  let sales = 0;
  let clicks = 0;
  const cpcs: number[] = [];
  let requiredFieldsPresent = rows.length > 0;
  let observedAt = typeof payload.summary?.generatedAt === "string" ? payload.summary.generatedAt : fallbackObservedAt ?? null;
  for (const row of rows) {
    const rowSpend = numberOrNull(row.spend);
    const rowSales = numberOrNull(row.salesAmount);
    const rowClicks = numberOrNull(row.clicks);
    const rowCpc = numberOrNull(row.currentCpc);
    if (rowSpend == null || rowSales == null || rowClicks == null || rowCpc == null) requiredFieldsPresent = false;
    spend += rowSpend ?? 0;
    sales += rowSales ?? 0;
    clicks += rowClicks ?? 0;
    if (rowCpc != null) cpcs.push(rowCpc);
    if (!observedAt && typeof row.date === "string") observedAt = row.date;
  }
  const cpc = clicks > 0 ? spend / clicks : cpcs.length ? cpcs.reduce((sum, value) => sum + value, 0) / cpcs.length : null;
  return { cpc, roas: spend > 0 ? (sales / spend) * 100 : null, spend: rows.length ? spend : null, observedAt, rowCount: rows.length, requiredFieldsPresent };
}

async function readLocalPayloads(limit = 2) {
  try {
    const files = (await fs.readdir(RECOMMENDATION_DIR)).filter((name) => /^rpp_auto_recommendations_\d{8}\.json$/.test(name)).sort().reverse().slice(0, limit);
    return await Promise.all(files.map(async (name) => ({ source: path.join(RECOMMENDATION_DIR, name), payload: JSON.parse(await fs.readFile(path.join(RECOMMENDATION_DIR, name), "utf8")) as RecommendationPayload })));
  } catch { return [] as { source: string; payload: RecommendationPayload }[]; }
}

function snapshotPayload(snapshot: RppDashboardSnapshot) {
  return { source: `db:rpp_dashboard_snapshots:${snapshot.syncedAt}`, payload: snapshot.recommendations as RecommendationPayload, observedAt: snapshot.syncedAt };
}

export async function readRppAnomalyComparison(): Promise<RppAnomalyComparison> {
  let payloads: { source: string; payload: RecommendationPayload; observedAt?: string | null }[] = [];
  try { payloads = (await readRecentRppDashboardSnapshots(2)).map(snapshotPayload); } catch { payloads = []; }
  if (payloads.length < 2) payloads = await readLocalPayloads(2);
  if (!payloads.length) {
    try { payloads = [{ source: STATIC_SNAPSHOT, payload: JSON.parse(await fs.readFile(STATIC_SNAPSHOT, "utf8")) as RecommendationPayload }]; } catch { payloads = []; }
  }
  const currentEntry = payloads[0];
  const previousEntry = payloads[1];
  const current = currentEntry ? aggregateRppAnomalySnapshot(currentEntry.payload, currentEntry.observedAt) : null;
  const previousFull = previousEntry ? aggregateRppAnomalySnapshot(previousEntry.payload, previousEntry.observedAt) : null;
  const previous = previousFull ? { cpc: previousFull.cpc, roas: previousFull.roas, spend: previousFull.spend, rowCount: previousFull.rowCount } : null;
  const anomalies = current ? detectRppAnomalies({
    current,
    previous: previous ?? { cpc: current.cpc, roas: current.roas, spend: current.spend, rowCount: current.rowCount },
  }) : [{ type: "DATA_MISSING", severity: "CRITICAL", label: "データ欠損", detail: "RPP候補データを取得できません" } satisfies RppAnomaly];
  return { current, previous, anomalies, currentSource: currentEntry?.source ?? null, previousSource: previousEntry?.source ?? null, comparisonReady: Boolean(previous) };
}
