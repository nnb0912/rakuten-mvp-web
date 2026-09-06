import { createRppExclusionJob } from "@/lib/rppExclusionJobs";
import { requireRppRole } from "@/lib/rppRouteAuth";
import { readRppAlertTargets } from "@/lib/rppTargets";
import { parseRppExclusionChanges, requireSingleRppExclusionChange } from "@/lib/rppExclusionBatch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const access = await requireRppRole("admin");
  if (!access.ok) return access.response;
  try {
    const body = (await request.json()) as { changes?: unknown; execute?: boolean };
    const changes = parseRppExclusionChanges(body.changes ?? [])
      .filter((row) => row.currentExcluded !== row.originalExcluded);
    if (!changes.length) return Response.json({ error: "変更対象がありません" }, { status: 400 });

    if (!body.execute) {
      return Response.json({ ok: true, dryRun: true, changes: changes.length });
    }
    requireSingleRppExclusionChange(changes);

    const releases = changes.filter((row) => row.currentExcluded === false);
    if (releases.length) {
      const current = await readRppAlertTargets();
      const savedIds = new Set(current.targets.map((row) => row.id));
      for (const release of releases) {
        const itemCode = release.itemCode.trim().toLowerCase();
        const configured = current.configuredTargets.filter((row) => row.itemCode === itemCode);
        if (!configured.length || configured.some((row) => !savedIds.has(row.id))) {
          throw new Error(`${itemCode}: 商品内の全RPP設定へ目標を保存してから除外解除してください`);
        }
      }
    }

    const job = await createRppExclusionJob(changes, { email: access.email, name: access.name });
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
