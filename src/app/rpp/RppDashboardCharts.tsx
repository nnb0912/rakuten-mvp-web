"use client";

import { buildRppDashboardPeriodSeries, buildRppKpiSummary, chartPolyline, type RppChartPeriod, type RppDashboardDailyMetric, type RppDeliveryComposition, type RppKpiAttribution, type RppKpiPeriod } from "@/lib/rppDashboardCharts";
import type { CSSProperties } from "react";
import { useState } from "react";

function yen(value: number) {
  return `${Math.round(value).toLocaleString("ja-JP")}円`;
}

function kpiYen(value: number | null, digits = 0) {
  return value == null ? "未取得" : `¥${value.toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function shortDate(value: string) {
  const [, month, day] = value.split("-");
  return `${month}/${day}`;
}

function KpiCard({ icon, label, value, suffix, badge, className = "" }: { icon: string; label: string; value: string; suffix?: string; badge: string; className?: string }) {
  return <article className={`panel rpp-metric-card ${className}`}>
    <span className="rpp-metric-icon" aria-hidden="true">{icon}</span>
    <b>{label}</b>
    <strong>{value}{suffix ? <em>{suffix}</em> : null}</strong>
    <small>{badge}</small>
  </article>;
}

export default function RppDashboardCharts({
  daily,
  delivery,
  targetRoas,
}: {
  daily: RppDashboardDailyMetric[];
  delivery: RppDeliveryComposition;
  targetRoas: number | null;
}) {
  const [period, setPeriod] = useState<RppChartPeriod>("DAY");
  const [kpiPeriod, setKpiPeriod] = useState<RppKpiPeriod>("MONTH");
  const [attribution, setAttribution] = useState<RppKpiAttribution>("720H");
  const { active, excluded, unknown, total } = delivery;
  const attributedDaily = daily.map((row) => ({
    ...row,
    sales: attribution === "12H" ? row.sales12h ?? null : row.sales720h ?? row.sales,
    orders: attribution === "12H" ? row.orders12h ?? null : row.orders720h ?? row.orders,
  }));
  const rows = buildRppDashboardPeriodSeries(attributedDaily, period);
  const hasObserved = rows.some((row) => row.spend != null || row.sales != null || row.clicks != null || row.orders != null);
  const kpis = buildRppKpiSummary(daily, kpiPeriod, attribution);
  const periodLabel = period === "DAY" ? "日次・直近14日" : period === "WEEK" ? "週次・直近12週" : "月次・直近12か月";
  const kpiBadge = kpiPeriod === "MONTH" ? "当月・全RPP" : kpiPeriod === "30D" ? "直近30日・全RPP" : "直近7日・全RPP";
  const attributionLabel = attribution === "720H" ? "720時間帰属" : "12時間帰属";
  const maxMoney = Math.max(...rows.flatMap((row) => [row.spend, row.sales].filter((value): value is number => value != null)), 1);
  const spendPoints = chartPolyline(rows.map((row) => row.spend), 560, 180, 22, maxMoney);
  const salesPoints = chartPolyline(rows.map((row) => row.sales), 560, 180, 22, maxMoney);
  const roasPoints = chartPolyline(rows.map((row) => row.roas));

  const activeRate = total ? active / total * 100 : 0;
  const excludedRate = total ? excluded / total * 100 : 0;
  const expectedLatest = rows.at(-1);
  const latestObserved = rows.findLast((row) => row.spend != null || row.sales != null || row.clicks != null);
  const latestRoas = rows.findLast((row) => row.roas != null);
  const roasDelta = kpis.roas != null && targetRoas != null ? Math.round(kpis.roas - targetRoas) : null;
  const roasBadge = roasDelta == null ? kpiBadge : `目標比 ${roasDelta >= 0 ? "+" : ""}${roasDelta.toLocaleString("ja-JP")}pt`;

  return <section className="rpp-dashboard-charts" aria-label="RPP実績グラフ">
    <div className="rpp-kpi-controls panel">
      <label><span>表示期間</span><select value={kpiPeriod} onChange={(event) => setKpiPeriod(event.target.value as RppKpiPeriod)}><option value="MONTH">当月</option><option value="30D">直近30日</option><option value="7D">直近7日</option></select></label>
      <div className="rpp-attribution-control"><span>ROAS集計</span><div role="group" aria-label="ROAS集計時間"><button type="button" className={attribution === "720H" ? "active" : ""} aria-pressed={attribution === "720H"} onClick={() => setAttribution("720H")}>720時間</button><button type="button" className={attribution === "12H" ? "active" : ""} aria-pressed={attribution === "12H"} onClick={() => setAttribution("12H")}>12時間</button></div></div>
      <small>対象データ期間：{shortDate(kpis.start)}～{shortDate(kpis.end)}（{kpiPeriod === "MONTH" ? "当月" : kpiPeriod === "30D" ? "直近30日" : "直近7日"}）</small>
    </div>
    <div className="rpp-chart-kpis" aria-label="全RPP実績概要">
      <KpiCard icon="↗" label="ROAS" value={kpis.roas == null ? "未取得" : `${kpis.roas.toLocaleString("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`} badge={roasBadge} className="is-primary" />
      <KpiCard icon="◎" label="広告経由売上" value={kpiYen(kpis.sales)} badge={`${kpiBadge}・${attributionLabel}`} />
      <KpiCard icon="▰" label="広告費" value={kpiYen(kpis.spend)} badge={kpiBadge} />
      <KpiCard icon="¥" label="平均CPC" value={kpiYen(kpis.averageCpc, 2)} badge={kpiBadge} />
      <KpiCard icon="◉" label="クリック" value={kpis.clicks == null ? "未取得" : Math.round(kpis.clicks).toLocaleString("ja-JP")} badge={kpiBadge} />
      <KpiCard icon="✓" label="CV / CVR" value={kpis.orders == null ? "未取得" : Math.round(kpis.orders).toLocaleString("ja-JP")} suffix={kpis.cvr == null ? undefined : ` / ${kpis.cvr.toFixed(2)}%`} badge={`${kpiBadge}・${attributionLabel}`} />
    </div>
    <article className="panel rpp-chart-card rpp-chart-wide">
      <div className="rpp-chart-heading">
        <div><p className="eyebrow">ALL RPP PERFORMANCE</p><h2>全RPP 広告費・売上推移</h2></div>
        <div><div className="rpp-period-tabs" role="group" aria-label="グラフ集計期間">{(["DAY", "WEEK", "MONTH"] as const).map((value) => <button type="button" className={period === value ? "active" : ""} aria-pressed={period === value} onClick={() => setPeriod(value)} key={value}>{value === "DAY" ? "日次" : value === "WEEK" ? "週次" : "月次"}</button>)}</div><div className="rpp-chart-legend"><span className="is-spend">広告費</span><span className="is-sales">売上（{attributionLabel}）</span></div></div>
      </div>
      {hasObserved ? <>
        <div className="rpp-chart-summary"><b>全RPP実績・{periodLabel}</b><span>週次・月次は取得済み日の合計</span><span>最終期間 {expectedLatest?.label ?? "なし"}</span><span>最終観測 {latestObserved?.label ?? "なし"}</span><span>広告費 {latestObserved?.spend == null ? "未取得" : yen(latestObserved.spend)}</span><span>売上 {latestObserved?.sales == null ? "未取得" : yen(latestObserved.sales)}</span></div>
        <svg className="rpp-line-chart" viewBox="0 0 560 180" role="img" aria-label={`全RPPの${periodLabel}広告費と売上推移`}>
          <g className="rpp-chart-grid"><line x1="22" y1="22" x2="538" y2="22"/><line x1="22" y1="90" x2="538" y2="90"/><line x1="22" y1="158" x2="538" y2="158"/></g>
          {spendPoints.map((points, index) => <polyline className="rpp-chart-line spend" points={points} key={`spend-${index}`}/>)}
          {salesPoints.map((points, index) => <polyline className="rpp-chart-line sales" points={points} key={`sales-${index}`}/>)}
          {rows.map((row, index) => {
            const x = 22 + index / Math.max(1, rows.length - 1) * 516;
            const spendY = row.spend == null ? null : 158 - row.spend / maxMoney * 136;
            const salesY = row.sales == null ? null : 158 - row.sales / maxMoney * 136;
            return <g key={row.date}>
              {spendY == null ? null : <circle className="rpp-chart-dot spend" cx={x} cy={spendY} r="3"><title>{`${row.label} 広告費 ${yen(row.spend!)}`}</title></circle>}
              {salesY == null ? null : <circle className="rpp-chart-dot sales" cx={x} cy={salesY} r="3"><title>{`${row.label} 売上 ${yen(row.sales!)}`}</title></circle>}
              {(index === 0 || index === rows.length - 1 || index % 3 === 0) ? <text x={x} y="176" textAnchor="middle">{row.label}</text> : null}
            </g>;
          })}
        </svg>
      </> : <div className="rpp-chart-empty">日別実績はまだ同期されていません</div>}
    </article>

    <article className="panel rpp-chart-card">
      <div className="rpp-chart-heading"><div><p className="eyebrow">ALL RPP EFFICIENCY</p><h2>全RPP ROAS推移（{attributionLabel}）</h2></div><strong className="rpp-chart-value">{latestRoas?.roas == null ? "未取得" : `${Math.round(latestRoas.roas)}%（${latestRoas.label}）`}</strong></div>
      {hasObserved && roasPoints.length ? <svg className="rpp-line-chart rpp-roas-chart" viewBox="0 0 560 180" role="img" aria-label={`${periodLabel}ROAS推移（売上${attributionLabel}）`}>
        <g className="rpp-chart-grid"><line x1="22" y1="22" x2="538" y2="22"/><line x1="22" y1="90" x2="538" y2="90"/><line x1="22" y1="158" x2="538" y2="158"/></g>
        {roasPoints.map((points, index) => <polyline className="rpp-chart-line roas" points={points} key={`roas-${index}`}/>)}
        {rows.map((row, index) => row.roas == null ? null : <circle key={row.date} className="rpp-chart-dot roas" cx={22 + index / Math.max(1, rows.length - 1) * 516} cy={158 - row.roas / Math.max(...rows.flatMap((item) => item.roas == null ? [] : [item.roas]), 1) * 136} r="3"><title>{`${row.label} ROAS ${Math.round(row.roas)}%`}</title></circle>)}
      </svg> : <div className="rpp-chart-empty">広告費と売上の両方がある日に表示します</div>}
    </article>

    <article className="panel rpp-chart-card rpp-delivery-chart">
      <div className="rpp-chart-heading"><div><p className="eyebrow">ALL RPP DELIVERY</p><h2>全RPP商品の配信構成</h2><small>{delivery.state === "CURRENT" ? "最新の完全なRMS観測" : delivery.state === "UNKNOWN" ? "配信状態は未確認" : "全RPP母集団は未取得"}</small></div><strong className="rpp-chart-value">{delivery.state === "UNAVAILABLE" ? "未取得" : `${total}商品`}</strong></div>
      {delivery.state === "UNAVAILABLE" ? <div className="rpp-chart-empty">全RPP商品の母集団を取得できていません</div> : <div className="rpp-donut-layout">
        <div className="rpp-donut" style={{ "--active-rate": `${activeRate * 3.6}deg`, "--excluded-rate": `${(activeRate + excludedRate) * 3.6}deg` } as CSSProperties}><span><b>{active}</b><small>稼働中</small></span></div>
        <ul><li><i className="is-active"/><span>稼働</span><b>{active}</b></li><li><i className="is-excluded"/><span>除外</span><b>{excluded}</b></li><li><i className="is-unknown"/><span>未確認</span><b>{unknown}</b></li></ul>
      </div>}
    </article>
  </section>;
}
