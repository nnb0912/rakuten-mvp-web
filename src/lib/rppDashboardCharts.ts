export type RppDashboardDailyMetric = {
  date: string;
  spend: number;
  sales: number;
  clicks: number;
};

export type RppDashboardChartPoint = RppDashboardDailyMetric & {
  label: string;
  roas: number | null;
};

export function buildRppDashboardChartSeries(rows: RppDashboardDailyMetric[]): RppDashboardChartPoint[] {
  return rows
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date))
    .map((row) => ({
      date: row.date,
      label: `${Number(row.date.slice(5, 7))}/${Number(row.date.slice(8, 10))}`,
      spend: Number.isFinite(row.spend) ? Math.max(0, row.spend) : 0,
      sales: Number.isFinite(row.sales) ? Math.max(0, row.sales) : 0,
      clicks: Number.isFinite(row.clicks) ? Math.max(0, Math.round(row.clicks)) : 0,
      roas: Number.isFinite(row.spend) && row.spend > 0 && Number.isFinite(row.sales)
        ? Math.max(0, row.sales / row.spend * 100)
        : null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function chartPolyline(values: Array<number | null>, width = 560, height = 180, inset = 22, maximum?: number) {
  const usable = values.flatMap((value) => value == null ? [] : [value]);
  if (!usable.length) return "";
  const max = maximum ?? Math.max(...usable, 1);
  const span = Math.max(1, values.length - 1);
  return values.map((value, index) => {
    if (value == null) return null;
    const x = inset + index / span * (width - inset * 2);
    const y = height - inset - value / max * (height - inset * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).filter(Boolean).join(" ");
}
