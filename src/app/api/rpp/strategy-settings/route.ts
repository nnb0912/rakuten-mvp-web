import { readRppStrategySettings, writeRppStrategySettings, type RppStrategySettings } from "@/lib/rppStrategySettings";
import { requireRppRole } from "@/lib/rppRouteAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const access = await requireRppRole("viewer");
  if (!access.ok) return access.response;
  return Response.json(await readRppStrategySettings());
}

export async function POST(request: Request) {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
  try {
    const result = await writeRppStrategySettings(await request.json() as Partial<RppStrategySettings>, access.email);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
