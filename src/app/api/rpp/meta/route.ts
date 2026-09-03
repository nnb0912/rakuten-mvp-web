import { readRppDashboardMeta } from "@/lib/rppRecommendations";
import { requireRppRole } from "@/lib/rppRouteAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const access = await requireRppRole("viewer");
  if (!access.ok) return access.response;
  return Response.json(await readRppDashboardMeta());
}
