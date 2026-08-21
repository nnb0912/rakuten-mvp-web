import { query, queryOne } from "@/lib/db";

export const dynamic = "force-dynamic";

type LatestAlertDate = {
  alert_date: string | null;
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 30), 1), 100);
  const status = searchParams.get("status") ?? "open";
  const requestedDate = searchParams.get("alertDate");

  const latest = await queryOne<LatestAlertDate>(
    `select max(alert_date)::text as alert_date
     from purchase_order_alerts`,
  );
  const alertDate = requestedDate ?? latest?.alert_date;

  if (!alertDate) {
    return Response.json({ alertDate: null, status, limit, summary: null, alerts: [] });
  }

  const summary = await queryOne(
    `select count(*)::int as alert_count,
            coalesce(sum(rounded_required_qty),0)::bigint::text as total_rounded_required_qty,
            coalesce(sum(raw_required_qty),0)::numeric(14,2)::text as total_raw_required_qty,
            min(coverage_start_date)::text as coverage_start_min,
            max(coverage_end_date)::text as coverage_end_max
     from purchase_order_alerts
     where alert_date = $1::date and status = $2`,
    [alertDate, status],
  );

  const alerts = await query(
    `select po.alert_date::text,
            po.product_code,
            coalesce(pk.item_name, null) as item_name,
            po.coverage_start_date::text,
            po.coverage_end_date::text,
            po.planned_units_in_coverage::numeric(14,2)::text,
            po.real_stock_qty,
            po.inbound_qty,
            po.reserved_or_secured_qty,
            po.reservation_remaining_qty,
            po.raw_required_qty::numeric(14,2)::text,
            po.rounded_required_qty,
            po.box_qty,
            po.moq,
            po.mcq,
            po.recommended_action,
            po.rationale->'warnings' as warnings,
            po.status,
            po.updated_at::text
     from purchase_order_alerts po
     left join product_kpi_current pk on lower(pk.product_code) = lower(po.product_code)
     where po.alert_date = $1::date and po.status = $2
     order by po.rounded_required_qty desc, po.product_code asc
     limit $3`,
    [alertDate, status, limit],
  );

  return Response.json({ alertDate, status, limit, summary, alerts });
}
