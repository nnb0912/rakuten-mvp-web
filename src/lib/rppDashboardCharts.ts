export type RppDashboardDailyMetric = {
  date: string;
  spend: number | null;
  sales: number | null;
  clicks: number | null;
};

export type RppDashboardChartPoint = Omit<RppDashboardDailyMetric, "spend" | "sales" | "clicks"> & {
  spend: number | null;
  sales: number | null;
  clicks: number | null;
  label: string;
  roas: number | null;
};

export type RppDeliveryComposition = {
  state: "CURRENT" | "UNKNOWN" | "UNAVAILABLE";
  total: number;
  active: number;
  excluded: number;
  unknown: number;
};

const DELIVERY_OBSERVATION_MAX_AGE_MS = 2 * 60 * 60_000;

export function buildRppDeliveryComposition(snapshot: {
  syncedAt?: string;
  rppData?: {
    allConfiguredTargets?: Array<{ itemCode: string }>;
    exclusionProducts: Array<{ itemCode: string; excluded: boolean }>;
    exclusionObservation?: { observedAt: string; complete: boolean };
  } | null;
} | null, now = new Date()): RppDeliveryComposition {
  const targets = snapshot?.rppData?.allConfiguredTargets;
  if (!targets?.length) return { state: "UNAVAILABLE", total: 0, active: 0, excluded: 0, unknown: 0 };
  const itemCodes = new Set(targets.map((row) => row.itemCode.trim().toLowerCase()).filter(Boolean));
  const total = itemCodes.size;
  if (!total) return { state: "UNAVAILABLE", total: 0, active: 0, excluded: 0, unknown: 0 };
  const observation = snapshot?.rppData?.exclusionObservation;
  const syncedMs = Date.parse(snapshot?.syncedAt ?? "");
  const observedMs = Date.parse(observation?.observedAt ?? "");
  const nowMs = now.getTime();
  const fresh = observation?.complete === true
    && Number.isFinite(syncedMs) && syncedMs <= nowMs && nowMs - syncedMs <= DELIVERY_OBSERVATION_MAX_AGE_MS
    && Number.isFinite(observedMs) && observedMs <= nowMs && nowMs - observedMs <= DELIVERY_OBSERVATION_MAX_AGE_MS;
  if (!fresh) return { state: "UNKNOWN", total, active: 0, excluded: 0, unknown: total };
  const products = new Map(snapshot!.rppData!.exclusionProducts.map((row) => [row.itemCode.trim().toLowerCase(), row]));
  let active = 0;
  let excluded = 0;
  for (const itemCode of itemCodes) {
    const product = products.get(itemCode);
    if (!product) continue;
    if (product.excluded) excluded += 1;
    else active += 1;
  }
  return { state: "CURRENT", total, active, excluded, unknown: Math.max(0, total - active - excluded) };
}

export function buildRppDashboardChartSeries(rows: RppDashboardDailyMetric[]): RppDashboardChartPoint[] {
  const todayJst = new Date(Date.now() + 9 * 60 * 60_000).toISOString().slice(0, 10);
  const observed = rows
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.date <= todayJst)
    .map((row) => ({
      date: row.date,
      label: `${Number(row.date.slice(5, 7))}/${Number(row.date.slice(8, 10))}`,
      spend: typeof row.spend === "number" && Number.isFinite(row.spend) ? Math.max(0, row.spend) : null,
      sales: typeof row.sales === "number" && Number.isFinite(row.sales) ? Math.max(0, row.sales) : null,
      clicks: typeof row.clicks === "number" && Number.isFinite(row.clicks) ? Math.max(0, Math.round(row.clicks)) : null,
      roas: typeof row.spend === "number" && Number.isFinite(row.spend) && row.spend > 0 && typeof row.sales === "number" && Number.isFinite(row.sales)
        ? Math.max(0, row.sales / row.spend * 100)
        : null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (observed.length < 2) return observed;
  const byDate = new Map(observed.map((row) => [row.date, row]));
  const filled: RppDashboardChartPoint[] = [];
  const cursor = new Date(`${observed[0].date}T00:00:00Z`);
  const end = new Date(`${observed.at(-1)!.date}T00:00:00Z`);
  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    filled.push(byDate.get(date) ?? { date, label: `${cursor.getUTCMonth() + 1}/${cursor.getUTCDate()}`, spend: null, sales: null, clicks: null, roas: null });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return filled;
}

export function chartPolyline(values: Array<number | null>, width = 560, height = 180, inset = 22, maximum?: number) {
  const usable = values.flatMap((value) => value == null ? [] : [value]);
  if (!usable.length) return [];
  const max = maximum ?? Math.max(...usable, 1);
  const span = Math.max(1, values.length - 1);
  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((value, index) => {
    if (value == null) {
      if (current.length) segments.push(current.join(" "));
      current = [];
      return;
    }
    const x = inset + index / span * (width - inset * 2);
    const y = height - inset - value / max * (height - inset * 2);
    current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (current.length) segments.push(current.join(" "));
  return segments;
}
