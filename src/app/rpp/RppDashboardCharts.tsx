import { buildRppDashboardChartSeries, chartPolyline, type RppDashboardDailyMetric } from "@/lib/rppDashboardCharts";
import type { CSSProperties } from "react";

function yen(value: number) {
  return `${Math.round(value).toLocaleString("ja-JP")}円`;
}

export default function RppDashboardCharts({
  daily,
  active,
  excluded,
  unknown,
}: {
  daily: RppDashboardDailyMetric[];
  active: number;
  excluded: number;
  unknown: number;
}) {
  const rows = buildRppDashboardChartSeries(daily);
  const maxMoney = Math.max(...rows.flatMap((row) => [row.spend, row.sales]), 1);
  const spendPoints = chartPolyline(rows.map((row) => row.spend), 560, 180, 22, maxMoney);
  const salesPoints = chartPolyline(rows.map((row) => row.sales), 560, 180, 22, maxMoney);
  const roasPoints = chartPolyline(rows.map((row) => row.roas));
  const total = active + excluded + unknown;
  const activeRate = total ? active / total * 100 : 0;
  const excludedRate = total ? excluded / total * 100 : 0;
  const latest = rows.at(-1);

  return <section className="rpp-dashboard-charts" aria-label="RPP実績グラフ">
    <article className="panel rpp-chart-card rpp-chart-wide">
      <div className="rpp-chart-heading">
        <div><p className="eyebrow">ALL RPP PERFORMANCE</p><h2>全RPP 広告費・売上推移</h2></div>
        <div className="rpp-chart-legend"><span className="is-spend">広告費</span><span className="is-sales">売上（720h）</span></div>
      </div>
      {rows.length ? <>
        <div className="rpp-chart-summary"><b>全RPP実績・{rows.length}日分</b><span>最新 広告費 {yen(latest?.spend ?? 0)}</span><span>売上 {yen(latest?.sales ?? 0)}</span></div>
        <svg className="rpp-line-chart" viewBox="0 0 560 180" role="img" aria-label="全RPPの日別広告費と売上推移">
          <g className="rpp-chart-grid"><line x1="22" y1="22" x2="538" y2="22"/><line x1="22" y1="90" x2="538" y2="90"/><line x1="22" y1="158" x2="538" y2="158"/></g>
          {spendPoints.map((points, index) => <polyline className="rpp-chart-line spend" points={points} key={`spend-${index}`}/>)}
          {salesPoints.map((points, index) => <polyline className="rpp-chart-line sales" points={points} key={`sales-${index}`}/>)}
          {rows.map((row, index) => {
            const x = 22 + index / Math.max(1, rows.length - 1) * 516;
            const spendY = 158 - row.spend / maxMoney * 136;
            const salesY = 158 - row.sales / maxMoney * 136;
            return <g key={row.date}>
              <circle className="rpp-chart-dot spend" cx={x} cy={spendY} r="3"><title>{row.label} 広告費 {yen(row.spend)}</title></circle>
              <circle className="rpp-chart-dot sales" cx={x} cy={salesY} r="3"><title>{row.label} 売上 {yen(row.sales)}</title></circle>
              {(index === 0 || index === rows.length - 1 || index % 3 === 0) ? <text x={x} y="176" textAnchor="middle">{row.label}</text> : null}
            </g>;
          })}
        </svg>
      </> : <div className="rpp-chart-empty">日別実績はまだ同期されていません</div>}
    </article>

    <article className="panel rpp-chart-card">
      <div className="rpp-chart-heading"><div><p className="eyebrow">ALL RPP EFFICIENCY</p><h2>全RPP ROAS推移（720h）</h2></div><strong className="rpp-chart-value">{latest?.roas == null ? "未取得" : `${Math.round(latest.roas)}%`}</strong></div>
      {roasPoints.length ? <svg className="rpp-line-chart rpp-roas-chart" viewBox="0 0 560 180" role="img" aria-label="日別ROAS推移（売上720h帰属）">
        <g className="rpp-chart-grid"><line x1="22" y1="22" x2="538" y2="22"/><line x1="22" y1="90" x2="538" y2="90"/><line x1="22" y1="158" x2="538" y2="158"/></g>
        {roasPoints.map((points, index) => <polyline className="rpp-chart-line roas" points={points} key={`roas-${index}`}/>)}
        {rows.map((row, index) => row.roas == null ? null : <circle key={row.date} className="rpp-chart-dot roas" cx={22 + index / Math.max(1, rows.length - 1) * 516} cy={158 - row.roas / Math.max(...rows.flatMap((item) => item.roas == null ? [] : [item.roas]), 1) * 136} r="3"><title>{row.label} ROAS {Math.round(row.roas)}%</title></circle>)}
      </svg> : <div className="rpp-chart-empty">広告費と売上の両方がある日に表示します</div>}
    </article>

    <article className="panel rpp-chart-card rpp-delivery-chart">
      <div className="rpp-chart-heading"><div><p className="eyebrow">DELIVERY</p><h2>配信構成</h2></div><strong className="rpp-chart-value">{total}商品</strong></div>
      <div className="rpp-donut-layout">
        <div className="rpp-donut" style={{ "--active-rate": `${activeRate * 3.6}deg`, "--excluded-rate": `${(activeRate + excludedRate) * 3.6}deg` } as CSSProperties}><span><b>{active}</b><small>稼働中</small></span></div>
        <ul><li><i className="is-active"/><span>稼働</span><b>{active}</b></li><li><i className="is-excluded"/><span>除外</span><b>{excluded}</b></li><li><i className="is-unknown"/><span>未確認</span><b>{unknown}</b></li></ul>
      </div>
    </article>
  </section>;
}
