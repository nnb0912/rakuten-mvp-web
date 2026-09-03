import { requireRppRole } from "@/lib/rppRouteAuth";
import { readRppBudgetSettings, writeRppBudgetSettings, type RppBudgetSettings } from "@/lib/rppBudgetSettings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const access = await requireRppRole("viewer");
  if (!access.ok) return access.response;
  return Response.json(await readRppBudgetSettings());
}

export async function POST(request: Request) {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
  try {
    const result = await writeRppBudgetSettings(await request.json() as Partial<RppBudgetSettings>, access.email);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
