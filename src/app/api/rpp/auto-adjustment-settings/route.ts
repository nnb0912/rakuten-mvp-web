import { readRppAutoAdjustmentSettings, writeRppAutoAdjustmentSettings, type RppAutoAdjustmentSettingsInput } from "@/lib/rppAutoAdjustmentSettings";
import { requireRppRole } from "@/lib/rppRouteAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const access = await requireRppRole("viewer");
  if (!access.ok) return access.response;
  return Response.json(await readRppAutoAdjustmentSettings());
}

export async function POST(request: Request) {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
  try {
    const body = (await request.json()) as RppAutoAdjustmentSettingsInput;
    const result = await writeRppAutoAdjustmentSettings(body);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
