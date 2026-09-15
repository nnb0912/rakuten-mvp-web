"use client";

import { buildRppCurrentMonthKpis, buildRppDashboardPeriodSeries, chartPolyline, type RppChartPeriod, type RppDashboardDailyMetric, type RppDeliveryComposition } from "@/lib/rppDashboardCharts";
import type { CSSProperties } from "react";
import { useState } from "react";

function yen(value: number) {
  return `${Math.round(value).toLocaleString("ja-JP")}円`;
}

export default function RppDashboardCharts({
  daily,
  delivery,
}: {
  daily: RppDashboardDailyMetric[];
  delivery: RppDeliveryComposition;
}) {
  const [period, setPeriod] = useState<RppChartPeriod>("DAY");
  const { active, excluded, unknown, total } = delivery;
  const rows = buildRppDashboardPeriodSeries(daily, period);
  const hasObserved = rows.some((row) => row.spend != null || row.sales != null || row.clicks != null || row.orders != null);
  const monthly = buildRppCurrentMonthKpis(daily);
  const periodLabel = period === "DAY" ? "日次・直近14日" : period === "WEEK" ? "週次・直近12週" : "月次・直近12か月";
  const maxMoney = Math.max(...rows.flatMap((row) => [row.spend, row.sales].filter((value): value is number => value != null)), 1);
  const spendPoints = chartPolyline(rows.map((row) => row.spend), 560, 180, 22, maxMoney);
  const salesPoints = chartPolyline(rows.map((row) => row.sales), 560, 180, 22, maxMoney);
  const roasPoints = chartPolyline(rows.map((row) => row.roas));

  const activeRate = total ? active / total * 100 : 0;
  const excludedRate = total ? excluded / total * 100 : 0;
  const expectedLatest = rows.at(-1);
  const latestObserved = rows.findLast((row) => row.spend != null || row.sales != null || row.clicks != null);
  const latestRoas = rows.findLast((row) => row.roas != null);

  return <section className="rpp-dashboard-charts" aria-label="RPP実績グラフ">
    <div className="rpp-chart-kpis" aria-label="当月クリック・CV概要">
      <article className="panel rpp-metric-card"><span className="rpp-metric-icon">⌁</span><b>クリック</b><strong>{monthly.clicks == null ? "未取得" : monthly.clicks.toLocaleString("ja-JP")}</strong><small>当月・全RPP</small></article>
      <article className="panel rpp-metric-card"><span className="rpp-metric-icon">✓</span><b>CV / CVR</b><strong>{monthly.orders == null ? "未取得" : monthly.orders.toLocaleString("ja-JP")}<em>{monthly.cvr == null ? "" : ` / ${monthly.cvr.toFixed(1)}%`}</em></strong><small>当月・720時間帰属・全RPP</small></article>
    </div>
    <article className="panel rpp-chart-card rpp-chart-wide">
      <div className="rpp-chart-heading">
        <div><p className="eyebrow">ALL RPP PERFORMANCE</p><h2>全RPP 広告費・売上推移</h2></div>
        <div><div className="rpp-period-tabs" role="group" aria-label="グラフ集計期間">{(["DAY", "WEEK", "MONTH"] as const).map((value) => <button type="button" className={period === value ? "active" : ""} aria-pressed={period === value} onClick={() => setPeriod(value)} key={value}>{value === "DAY" ? "日次" : value === "WEEK" ? "週次" : "月次"}</button>)}</div><div className="rpp-chart-legend"><span className="is-spend">広告費</span><span className="is-sales">売上（720時間帰属）</span></div></div>
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
              {spendY == null ? null : <circle className="rpp-chart-dot spend" cx={x} cy={spendY} r="3"><title>{row.label} 広告費 {yen(row.spend!)}</title></circle>}
              {salesY == null ? null : <circle className="rpp-chart-dot sales" cx={x} cy={salesY} r="3"><title>{row.label} 売上 {yen(row.sales!)}</title></circle>}
              {(index === 0 || index === rows.length - 1 || index % 3 === 0) ? <text x={x} y="176" textAnchor="middle">{row.label}</text> : null}
            </g>;
          })}
        </svg>
      </> : <div className="rpp-chart-empty">日別実績はまだ同期されていません</div>}
    </article>

    <article className="panel rpp-chart-card">
      <div className="rpp-chart-heading"><div><p className="eyebrow">ALL RPP EFFICIENCY</p><h2>全RPP ROAS推移（720時間帰属）</h2></div><strong className="rpp-chart-value">{latestRoas?.roas == null ? "未取得" : `${Math.round(latestRoas.roas)}%（${latestRoas.label}）`}</strong></div>
      {hasObserved && roasPoints.length ? <svg className="rpp-line-chart rpp-roas-chart" viewBox="0 0 560 180" role="img" aria-label={`${periodLabel}ROAS推移（売上720時間帰属）`}>
        <g className="rpp-chart-grid"><line x1="22" y1="22" x2="538" y2="22"/><line x1="22" y1="90" x2="538" y2="90"/><line x1="22" y1="158" x2="538" y2="158"/></g>
        {roasPoints.map((points, index) => <polyline className="rpp-chart-line roas" points={points} key={`roas-${index}`}/>)}
        {rows.map((row, index) => row.roas == null ? null : <circle key={row.date} className="rpp-chart-dot roas" cx={22 + index / Math.max(1, rows.length - 1) * 516} cy={158 - row.roas / Math.max(...rows.flatMap((item) => item.roas == null ? [] : [item.roas]), 1) * 136} r="3"><title>{row.label} ROAS {Math.round(row.roas)}%</title></circle>)}
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
