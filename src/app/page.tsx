import { query, queryOne } from "@/lib/db";

export const dynamic = "force-dynamic";

type DashboardSummary = {
  sales: string;
  gross_profit: string;
  ad_cost_total: string;
  net_profit: string;
  units: string;
  product_count: string;
};

type ProductRow = {
  product_code: string;
  item_name: string | null;
  sales_30d: string;
  net_profit_30d: string;
  ad_cost_30d: string;
  open_alert_types: string[];
};

type RecommendationRow = {
  id: number;
  product_code: string;
  rec_type: string;
  title: string;
  priority: number;
};

type PurchaseOrderSummary = {
  alert_count: number;
  total_rounded_required_qty: string;
  total_raw_required_qty: string;
  coverage_start_min: string | null;
  coverage_end_max: string | null;
};

type PurchaseOrderAlertRow = {
  product_code: string;
  item_name: string | null;
  coverage_end_date: string;
  planned_units_in_coverage: string;
  real_stock_qty: number;
  inbound_qty: number;
  raw_required_qty: string;
  rounded_required_qty: number;
  box_qty: number | null;
  moq: number | null;
  mcq: number | null;
  recommended_action: string;
  warnings: string[] | null;
};

function yen(value: string | number | null | undefined) {
  return `${Number(value ?? 0).toLocaleString("ja-JP")}円`;
}

function qty(value: string | number | null | undefined, digits = 0) {
  return Number(value ?? 0).toLocaleString("ja-JP", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

export default async function Home() {
  const summary = await queryOne<DashboardSummary>(
    `select
       coalesce(sum(sales),0)::bigint::text as sales,
       coalesce(sum(gross_profit),0)::bigint::text as gross_profit,
       coalesce(sum(ad_cost_total),0)::bigint::text as ad_cost_total,
       coalesce(sum(net_profit),0)::bigint::text as net_profit,
       coalesce(sum(units),0)::bigint::text as units,
       count(*)::text as product_count
     from monthly_product_profit
     where month = '2026-06-01'`,
  );

  const products = await query<ProductRow>(
    `select product_code, item_name, sales_30d::bigint::text, net_profit_30d::bigint::text,
            ad_cost_30d::bigint::text, open_alert_types
     from product_kpi_current
     order by net_profit_30d asc
     limit 10`,
  );

  const recommendations = await query<RecommendationRow>(
    `select id, product_code, rec_type, title, priority
     from ai_recommendations
     where status='proposed'
     order by priority desc, id asc
     limit 10`,
  );

  const sync = await query(
    `select distinct on (job_name) job_name, status, finished_at::text, rows_processed
     from data_sync_status
     order by job_name, started_at desc`,
  );

  const latestPurchaseOrderDate = await queryOne<{ alert_date: string | null }>(
    `select max(alert_date)::text as alert_date
     from purchase_order_alerts`,
  );

  const purchaseOrderSummary = latestPurchaseOrderDate?.alert_date
    ? await queryOne<PurchaseOrderSummary>(
        `select count(*)::int as alert_count,
                coalesce(sum(rounded_required_qty),0)::bigint::text as total_rounded_required_qty,
                coalesce(sum(raw_required_qty),0)::numeric(14,2)::text as total_raw_required_qty,
                min(coverage_start_date)::text as coverage_start_min,
                max(coverage_end_date)::text as coverage_end_max
         from purchase_order_alerts
         where alert_date = $1::date and status = 'open'`,
        [latestPurchaseOrderDate.alert_date],
      )
    : null;

  const purchaseOrderAlerts = latestPurchaseOrderDate?.alert_date
    ? await query<PurchaseOrderAlertRow>(
        `select po.product_code,
                coalesce(pk.item_name, null) as item_name,
                po.coverage_end_date::text,
                po.planned_units_in_coverage::numeric(14,2)::text,
                po.real_stock_qty,
                po.inbound_qty,
                po.raw_required_qty::numeric(14,2)::text,
                po.rounded_required_qty,
                po.box_qty,
                po.moq,
                po.mcq,
                po.recommended_action,
                po.rationale->'warnings' as warnings
         from purchase_order_alerts po
         left join product_kpi_current pk on lower(pk.product_code) = lower(po.product_code)
         where po.alert_date = $1::date and po.status = 'open'
         order by po.rounded_required_qty desc, po.product_code asc
         limit 10`,
        [latestPurchaseOrderDate.alert_date],
      )
    : [];

  return (
    <main className="page-shell">
      <section className="hero">
        <p className="eyebrow">Rakuten MVP / local preview</p>
        <h1>楽天管理システム MVP</h1>
        <p>Googleログイン後に確認するローカルMVP版。2026年6月の集計と追加発注アラートを表示しています。</p>
      </section>

      <section className="grid cards">
        <div className="card"><span>売上</span><strong>{yen(summary?.sales)}</strong></div>
        <div className="card"><span>粗利</span><strong>{yen(summary?.gross_profit)}</strong></div>
        <div className="card"><span>広告費</span><strong>{yen(summary?.ad_cost_total)}</strong></div>
        <div className="card"><span>広告費込み利益</span><strong>{yen(summary?.net_profit)}</strong></div>
        <div className="card"><span>販売数</span><strong>{Number(summary?.units ?? 0).toLocaleString("ja-JP")}</strong></div>
        <div className="card"><span>商品数</span><strong>{Number(summary?.product_count ?? 0).toLocaleString("ja-JP")}</strong></div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>追加発注アラート（上位10）</h2>
            <p>
              対象日 {latestPurchaseOrderDate?.alert_date ?? "未生成"} / 件数 {qty(purchaseOrderSummary?.alert_count)} / 発注候補合計 {qty(purchaseOrderSummary?.total_rounded_required_qty)}個
              {purchaseOrderSummary?.coverage_end_max ? ` / 最大カバー ${purchaseOrderSummary.coverage_end_max}` : ""}
            </p>
          </div>
          <div className="inline-links">
            <a className="text-link" href="/rpp">RPP運用候補</a>
            <a className="text-link" href="/api/purchase-order-alerts?limit=10">API JSON</a>
          </div>
        </div>
        <table className="wide-table">
          <thead><tr><th>商品</th><th>発注候補</th><th>raw必要数</th><th>計画数</th><th>実在庫</th><th>入荷待ち</th><th>箱/MOQ/MCQ</th><th>注意</th></tr></thead>
          <tbody>
            {purchaseOrderAlerts.map((a) => (
              <tr key={a.product_code}>
                <td><b>{a.product_code}</b><br /><small>{a.item_name ?? a.recommended_action}</small></td>
                <td className="strong-number">{qty(a.rounded_required_qty)}個</td>
                <td>{qty(a.raw_required_qty, 2)}</td>
                <td>{qty(a.planned_units_in_coverage, 2)}</td>
                <td>{qty(a.real_stock_qty)}</td>
                <td>{qty(a.inbound_qty)}</td>
                <td><small>箱 {qty(a.box_qty)}<br />MOQ {a.moq ? qty(a.moq) : "-"}<br />MCQ {a.mcq ? qty(a.mcq) : "-"}</small></td>
                <td><small>{(a.warnings ?? []).slice(0, 2).join(" / ")}</small></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>商品一覧（利益ワースト10）</h2>
        <table>
          <thead><tr><th>商品</th><th>売上</th><th>広告費</th><th>利益</th><th>アラート</th></tr></thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.product_code}>
                <td><b>{p.product_code}</b><br /><small>{p.item_name}</small></td>
                <td>{yen(p.sales_30d)}</td>
                <td>{yen(p.ad_cost_30d)}</td>
                <td className={Number(p.net_profit_30d) < 0 ? "negative" : ""}>{yen(p.net_profit_30d)}</td>
                <td>{(p.open_alert_types ?? []).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="grid two">
        <div className="panel">
          <h2>AI提案（上位10）</h2>
          <ul className="list">
            {recommendations.map((r) => (
              <li key={r.id}><b>P{r.priority}</b> {r.title}<br /><small>{r.product_code} / {r.rec_type}</small></li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <h2>データ更新ステータス</h2>
          <ul className="list">
            {sync.map((j) => (
              <li key={String(j.job_name)}><b>{String(j.status)}</b> {String(j.job_name)}<br /><small>{String(j.finished_at ?? "未完了")} / rows {String(j.rows_processed ?? "-")}</small></li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
