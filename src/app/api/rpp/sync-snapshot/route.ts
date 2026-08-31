import { timingSafeEqual } from "crypto";
import { readLatestRppDashboardSnapshot, saveRppDashboardSnapshot } from "@/lib/rppDashboardSnapshots";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function authorized(request: Request) {
  const expected = process.env.RPP_SNAPSHOT_SYNC_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const snapshot = await readLatestRppDashboardSnapshot();
    return Response.json({ ok: true, snapshot });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const snapshot = await saveRppDashboardSnapshot(await request.json());
    return Response.json({ ok: true, syncedAt: snapshot.syncedAt, recommendationCount: snapshot.recommendations.recommendations.length }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
