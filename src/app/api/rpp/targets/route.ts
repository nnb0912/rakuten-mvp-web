import { deleteRppAlertTarget, readRppAlertTargets, seedMissingRppAlertTargets, upsertRppAlertTarget, type RppAlertTargetInput } from "@/lib/rppTargets";
import { requireRppRole } from "@/lib/rppRouteAuth";
import { heartbeatRppEditLock, listActiveRppEditLocks, releaseRppEditLock } from "@/lib/rppCollaboration";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const access = await requireRppRole("viewer");
  if (!access.ok) return access.response;
  const data = await readRppAlertTargets();
  return Response.json(data);
}

export async function POST(request: Request) {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
  try {
    const body = (await request.json()) as (RppAlertTargetInput & { action?: string; editLockToken?: string });
    if (body.action === "seedMissing") {
      const locks = await listActiveRppEditLocks();
      if (locks.length) return Response.json({ error: `${locks[0].actorName}が商品設定を編集中です。一括作成は完了後に実行してください` }, { status: 409 });
      const result = await seedMissingRppAlertTargets(body);
      return Response.json({ ok: true, ...result });
    }
    if (!body.editLockToken) return Response.json({ error: "編集ロックが必要です" }, { status: 409 });
    const lock = await heartbeatRppEditLock(body.itemCode, body.editLockToken, access.email);
    if (!lock) return Response.json({ error: "編集ロックの有効期限が切れたか、他の担当者が編集中です" }, { status: 409 });
    const target = await upsertRppAlertTarget(body);
    await releaseRppEditLock(body.itemCode, body.editLockToken, access.email);
    return Response.json({ ok: true, target });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
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
