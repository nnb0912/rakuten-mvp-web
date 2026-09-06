import {
  acquireRppEditLock,
  heartbeatRppEditLock,
  listActiveRppEditLocks,
  releaseRppEditLock,
} from "@/lib/rppCollaboration";
import { listRecentRppExclusionJobs } from "@/lib/rppExclusionJobs";
import { requireRppRole } from "@/lib/rppRouteAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const access = await requireRppRole("viewer");
  if (!access.ok) return access.response;
  const [locks, jobs] = await Promise.all([
    listActiveRppEditLocks(),
    listRecentRppExclusionJobs(20),
  ]);
  return Response.json({
    ok: true,
    locks,
    activeOperations: jobs
      .filter((job) => job.status === "pending" || job.status === "running")
      .map((job) => ({
        id: job.id,
        status: job.status,
        actorName: job.createdByName || "担当者",
        itemCodes: job.changes.map((row) => row.itemCode),
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      })),
  });
}

export async function POST(request: Request) {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
  try {
    const body = await request.json() as { action?: unknown; itemCode?: unknown; token?: unknown };
    const action = String(body.action || "");
    const itemCode = typeof body.itemCode === "string" ? body.itemCode : "";
    const token = typeof body.token === "string" ? body.token : "";
    if (!itemCode) return Response.json({ error: "itemCode is required" }, { status: 400 });

    if (action === "acquire") {
      const result = await acquireRppEditLock(itemCode, { email: access.email, name: access.name });
      return Response.json(result, { status: result.ok ? 200 : 409 });
    }
    if (action === "heartbeat") {
      if (!token) return Response.json({ error: "token is required" }, { status: 400 });
      const lock = await heartbeatRppEditLock(itemCode, token, access.email);
      return lock
        ? Response.json({ ok: true, lock })
        : Response.json({ error: "編集ロックの有効期限が切れました" }, { status: 409 });
    }
    if (action === "release") {
      if (!token) return Response.json({ error: "token is required" }, { status: 400 });
      return Response.json({ ok: await releaseRppEditLock(itemCode, token, access.email) });
    }
    return Response.json({ error: "unsupported action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
