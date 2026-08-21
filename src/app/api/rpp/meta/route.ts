import { readRppDashboardMeta } from "@/lib/rppRecommendations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json(await readRppDashboardMeta());
}
