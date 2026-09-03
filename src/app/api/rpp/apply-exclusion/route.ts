import { createRppExclusionJob } from "@/lib/rppExclusionJobs";
import { requireRppRole } from "@/lib/rppRouteAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ExclusionChange = { itemCode: string; currentExcluded: boolean; originalExcluded?: boolean };

export async function POST(request: Request) {
  const access = await requireRppRole("admin");
  if (!access.ok) return access.response;
  try {
    const body = (await request.json()) as { changes?: ExclusionChange[]; execute?: boolean };
    const changes = (body.changes ?? []).filter((row) => row.itemCode && row.currentExcluded !== row.originalExcluded);
    if (!changes.length) return Response.json({ error: "変更対象がありません" }, { status: 400 });

    if (!body.execute) {
      return Response.json({ ok: true, dryRun: true, changes: changes.length });
    }

    const job = await createRppExclusionJob(changes);
    return Response.json({
      ok: true,
      queued: true,
      productionChange: false,
      jobId: job.id,
      status: job.status,
      changes: job.changes.length,
      csvContent: job.csvContent,
      reason: "RMS反映ジョブをMac Studioワーカーへ登録しました。処理完了後にRMS読戻し結果で状態更新します。",
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
