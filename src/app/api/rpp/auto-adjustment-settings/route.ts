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
    const current = await readRppAutoAdjustmentSettings();
    const result = await writeRppAutoAdjustmentSettings({
      ...body,
      // These product-specific fallback values are intentionally hidden from this
      // screen. Preserve the latest server values so a stale tab cannot rewind them.
      floorCpc: current.settings.floorCpc,
      itemCpcMax: current.settings.itemCpcMax,
      keywordCpcMax: current.settings.keywordCpcMax,
      roasFloor: current.settings.roasFloor,
      itemEnabledDefault: current.settings.itemEnabledDefault,
      keywordEnabledDefault: current.settings.keywordEnabledDefault,
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
