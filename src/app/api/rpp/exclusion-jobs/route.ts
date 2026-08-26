import { claimNextRppExclusionJob, completeRppExclusionJob, listRecentRppExclusionJobs } from "@/lib/rppExclusionJobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

function verifyWorker(request: Request) {
  const token = process.env.RPP_EXCLUSION_WORKER_TOKEN;
  if (!token) return false;
  const auth = request.headers.get("authorization") ?? "";
  return auth === `Bearer ${token}`;
}

export async function GET(request: Request) {
  if (!verifyWorker(request)) return unauthorized();
  const { searchParams } = new URL(request.url);
  if (searchParams.get("claim") === "1") {
    const job = await claimNextRppExclusionJob();
    return Response.json({ ok: true, job });
  }
  const jobs = await listRecentRppExclusionJobs(Number(searchParams.get("limit") ?? 20));
  return Response.json({ ok: true, jobs });
}

export async function POST(request: Request) {
  if (!verifyWorker(request)) return unauthorized();
  const body = await request.json() as { id?: string; ok?: boolean; csvPath?: string; error?: string; result?: unknown };
  if (!body.id) return Response.json({ error: "id is required" }, { status: 400 });
  await completeRppExclusionJob(body.id, Boolean(body.ok), { csvPath: body.csvPath, error: body.error, result: body.result });
  return Response.json({ ok: true });
}
