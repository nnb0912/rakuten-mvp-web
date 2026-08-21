import { query, queryOne } from "@/lib/db";

export const dynamic = "force-dynamic";

type Summary = {
  sales: string;
  gross_profit: string;
  ad_cost_total: string;
  net_profit: string;
  units: string;
  product_count: string;
};

export async function GET() {
  const month = "2026-06-01";
  const summary = await queryOne<Summary>(
    `select
       coalesce(sum(sales),0)::bigint::text as sales,
       coalesce(sum(gross_profit),0)::bigint::text as gross_profit,
       coalesce(sum(ad_cost_total),0)::bigint::text as ad_cost_total,
       coalesce(sum(net_profit),0)::bigint::text as net_profit,
       coalesce(sum(units),0)::bigint::text as units,
       count(*)::text as product_count
     from monthly_product_profit
     where month = $1::date`,
    [month],
  );

  const alerts = await query(
    `select alert_type, count(*)::int as count
     from product_alerts
     where alert_date = '2026-06-30' and status = 'open'
     group by alert_type
     order by alert_type`,
  );

  const worstProducts = await query(
    `select product_code, item_name, sales::bigint::text, net_profit::bigint::text, ad_cost_total::bigint::text
     from monthly_product_profit
     where month = $1::date
     order by net_profit asc
     limit 5`,
    [month],
  );

  return Response.json({ month, summary, alerts, worstProducts });
}
