import { deleteRppAlertTarget, readRppAlertTargets, seedMissingRppAlertTargets, upsertRppAlertTarget, type RppAlertTargetInput } from "@/lib/rppTargets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const data = await readRppAlertTargets();
  return Response.json(data);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as (RppAlertTargetInput & { action?: string });
    if (body.action === "seedMissing") {
      const result = await seedMissingRppAlertTargets(body);
      return Response.json({ ok: true, ...result });
    }
    const target = await upsertRppAlertTarget(body);
    return Response.json({ ok: true, target });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  try {
    const result = await deleteRppAlertTarget(id);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
