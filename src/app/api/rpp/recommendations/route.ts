import { readRppRecommendations, updateRppApproval, type RppApprovalStatus } from "@/lib/rppRecommendations";
import { requireRppRole } from "@/lib/rppRouteAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const access = await requireRppRole("viewer");
  if (!access.ok) return access.response;
  const data = await readRppRecommendations();
  return Response.json({
    source: data.filePath,
    summary: data.summary,
    recommendations: data.recommendations,
  });
}

export async function PATCH(request: Request) {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
  const body = (await request.json()) as { id?: string; status?: RppApprovalStatus; note?: string };
  if (!body.id || !body.status) {
    return Response.json({ error: "id and status are required" }, { status: 400 });
  }
  try {
    const approval = await updateRppApproval(body.id, body.status, body.note ?? "");
    return Response.json({ ok: true, id: body.id, approval });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
