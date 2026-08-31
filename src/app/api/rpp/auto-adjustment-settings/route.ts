import { readRppAutoAdjustmentSettings, writeRppAutoAdjustmentSettings, type RppAutoAdjustmentSettingsInput } from "@/lib/rppAutoAdjustmentSettings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json(await readRppAutoAdjustmentSettings());
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RppAutoAdjustmentSettingsInput;
    const result = await writeRppAutoAdjustmentSettings(body);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
