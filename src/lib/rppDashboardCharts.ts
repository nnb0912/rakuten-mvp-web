export type RppDashboardDailyMetric = {
  date: string;
  spend: number | null;
  sales: number | null;
  clicks: number | null;
  orders?: number | null;
  sales12h?: number | null;
  orders12h?: number | null;
  sales720h?: number | null;
  orders720h?: number | null;
};

export type RppKpiPeriod = "MONTH" | "30D" | "7D";
export type RppKpiAttribution = "720H" | "12H";

export type RppDashboardChartPoint = Omit<RppDashboardDailyMetric, "spend" | "sales" | "clicks"> & {
  spend: number | null;
  sales: number | null;
  clicks: number | null;
  orders: number | null;
  label: string;
  roas: number | null;
  cvr: number | null;
};

export type RppChartPeriod = "DAY" | "WEEK" | "MONTH";

export type RppDeliveryComposition = {
  state: "CURRENT" | "UNKNOWN" | "UNAVAILABLE";
  total: number;
  active: number;
  excluded: number;
  unknown: number;
};

const DELIVERY_OBSERVATION_MAX_AGE_MS = 2 * 60 * 60_000;

export function buildRppKpiSummary(rows: RppDashboardDailyMetric[], period: RppKpiPeriod, attribution: RppKpiAttribution, now = new Date()) {
  const today = jstToday(now);
  const latestObserved = rows.filter((row) => row.date <= today && [row.spend, row.sales, row.clicks, row.orders, row.sales12h, row.sales720h].some((value) => typeof value === "number")).map((row) => row.date).sort().at(-1);
  const end = latestObserved ?? today;
  const endDate = utcDate(end);
  const startDate = new Date(endDate);
  if (period === "MONTH") startDate.setUTCDate(1);
  else startDate.setUTCDate(startDate.getUTCDate() - (period === "30D" ? 29 : 6));
  const start = isoDate(startDate);
  const selected = rows.filter((row) => row.date >= start && row.date <= end);
  const values = (field: "spend" | "clicks" | "sales" | "orders") => selected.flatMap((row) => {
    const value = field === "sales"
      ? attribution === "12H" ? row.sales12h : row.sales720h ?? row.sales
      : field === "orders"
        ? attribution === "12H" ? row.orders12h : row.orders720h ?? row.orders
        : row[field];
    return typeof value === "number" && Number.isFinite(value) ? [Math.max(0, value)] : [];
  });
  const sum = (field: "spend" | "clicks" | "sales" | "orders") => {
    const list = values(field);
    return list.length ? list.reduce((total, value) => total + value, 0) : null;
  };
  const spend = sum("spend"), sales = sum("sales"), clicks = sum("clicks"), orders = sum("orders");
  return {
    start, end, spend, sales, clicks, orders,
    roas: spend != null && spend > 0 && sales != null ? sales / spend * 100 : null,
    averageCpc: spend != null && clicks != null && clicks > 0 ? spend / clicks : null,
    cvr: clicks != null && clicks > 0 && orders != null ? orders / clicks * 100 : null,
  };
}

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
      orders: typeof row.orders === "number" && Number.isFinite(row.orders) ? Math.max(0, Math.round(row.orders)) : null,
      roas: typeof row.spend === "number" && Number.isFinite(row.spend) && row.spend > 0 && typeof row.sales === "number" && Number.isFinite(row.sales)
        ? Math.max(0, row.sales / row.spend * 100)
        : null,
      cvr: typeof row.clicks === "number" && row.clicks > 0 && typeof row.orders === "number" && Number.isFinite(row.orders)
        ? Math.max(0, row.orders / row.clicks * 100)
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
    filled.push(byDate.get(date) ?? { date, label: `${cursor.getUTCMonth() + 1}/${cursor.getUTCDate()}`, spend: null, sales: null, clicks: null, orders: null, roas: null, cvr: null });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return filled;
}

function jstToday(now: Date) {
  return new Date(now.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10);
}

function utcDate(date: string) {
  return new Date(`${date}T00:00:00Z`);
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function buildRppDashboardPeriodSeries(rows: RppDashboardDailyMetric[], period: RppChartPeriod, now = new Date()): RppDashboardChartPoint[] {
  const today = jstToday(now);
  const end = utcDate(today);
  const buckets: Array<{ start: string; end: string; label: string }> = [];
  if (period === "DAY") {
    for (let offset = 13; offset >= 0; offset -= 1) {
      const date = new Date(end); date.setUTCDate(date.getUTCDate() - offset);
      buckets.push({ start: isoDate(date), end: isoDate(date), label: `${date.getUTCMonth() + 1}/${date.getUTCDate()}` });
    }
  } else if (period === "WEEK") {
    const currentMonday = new Date(end);
    currentMonday.setUTCDate(currentMonday.getUTCDate() - ((currentMonday.getUTCDay() + 6) % 7));
    for (let offset = 11; offset >= 0; offset -= 1) {
      const start = new Date(currentMonday); start.setUTCDate(start.getUTCDate() - offset * 7);
      const finish = new Date(start); finish.setUTCDate(finish.getUTCDate() + 6);
      if (finish > end) finish.setTime(end.getTime());
      buckets.push({ start: isoDate(start), end: isoDate(finish), label: `${start.getUTCMonth() + 1}/${start.getUTCDate()}週` });
    }
  } else {
    const currentMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    for (let offset = 11; offset >= 0; offset -= 1) {
      const start = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() - offset, 1));
      const finish = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
      if (finish > end) finish.setTime(end.getTime());
      buckets.push({ start: isoDate(start), end: isoDate(finish), label: `${start.getUTCFullYear()}/${start.getUTCMonth() + 1}` });
    }
  }
  const validRows = rows.filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.date <= today);
  return buckets.map((bucket) => {
    const selected = validRows.filter((row) => row.date >= bucket.start && row.date <= bucket.end);
    const sum = (field: "spend" | "sales" | "clicks" | "orders") => {
      const values = selected.flatMap((row) => typeof row[field] === "number" && Number.isFinite(row[field]) ? [Math.max(0, Number(row[field]))] : []);
      return values.length ? values.reduce((total, value) => total + value, 0) : null;
    };
    const spend = sum("spend"), sales = sum("sales"), clicks = sum("clicks"), orders = sum("orders");
    return { date: bucket.start, label: bucket.label, spend, sales, clicks, orders, roas: spend != null && spend > 0 && sales != null ? sales / spend * 100 : null, cvr: clicks != null && clicks > 0 && orders != null ? orders / clicks * 100 : null };
  });
}

export function buildRppCurrentMonthKpis(rows: RppDashboardDailyMetric[], now = new Date()) {
  const today = jstToday(now);
  const month = today.slice(0, 7);
  const selected = rows.filter((row) => row.date.startsWith(month) && row.date <= today);
  const clicksValues = selected.flatMap((row) => typeof row.clicks === "number" && Number.isFinite(row.clicks) ? [Math.max(0, row.clicks)] : []);
  const orderValues = selected.flatMap((row) => typeof row.orders === "number" && Number.isFinite(row.orders) ? [Math.max(0, row.orders)] : []);
  const clicks = clicksValues.length ? Math.round(clicksValues.reduce((sum, value) => sum + value, 0)) : null;
  const orders = orderValues.length ? Math.round(orderValues.reduce((sum, value) => sum + value, 0)) : null;
  return { clicks, orders, cvr: clicks != null && clicks > 0 && orders != null ? orders / clicks * 100 : null };
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
