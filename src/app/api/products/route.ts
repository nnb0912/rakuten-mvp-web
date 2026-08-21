import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const preset = searchParams.get("preset") ?? "all";
  const limit = Math.min(Number(searchParams.get("limit") ?? 30), 100);

  const where = preset === "loss" ? "where net_profit_30d < 0" : "";
  const sort = preset === "sales" ? "sales_30d desc" : "net_profit_30d asc";

  const products = await query(
    `select product_code, item_name, assignee,
            units_30d, sales_30d::bigint::text, gross_profit_30d::bigint::text,
            net_profit_30d::bigint::text, ad_cost_30d::bigint::text,
            ad_ratio_30d::text, rpp_active, latest_inventory, days_of_stock::text,
            open_alert_types
     from product_kpi_current
     ${where}
     order by ${sort}
     limit $1`,
    [limit],
  );

  return Response.json({ preset, limit, products });
}
