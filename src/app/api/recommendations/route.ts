import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") ?? "proposed";
  const limit = Math.min(Number(searchParams.get("limit") ?? 30), 100);

  const recommendations = await query(
    `select id, created_date::text, product_code, rec_type, title,
            left(body, 260) as body_preview,
            impact_yen::bigint::text, priority, status
     from ai_recommendations
     where status = $1
     order by priority desc, id asc
     limit $2`,
    [status, limit],
  );

  return Response.json({ status, limit, recommendations });
}
