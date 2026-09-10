import { timingSafeEqual } from "crypto";
import { readLatestRppDashboardSnapshot, saveRppDashboardSnapshot } from "@/lib/rppDashboardSnapshots";
import { claimRppDeliveryReservation, markRppDeliveryReservation, readPendingRppDeliveryReservations, readRppDeliverySchedules } from "@/lib/rppDeliverySchedules";
import { readRppNightPauseProducts } from "@/lib/rppNightPause";
import { readRppAlertTargets } from "@/lib/rppTargets";

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
    const { searchParams } = new URL(request.url);
    if (searchParams.get("resource") === "targets") {
      const data = await readRppAlertTargets();
      return Response.json({ ok: true, targets: data.targets, updatedAt: new Date().toISOString() });
    }
    if (searchParams.get("resource") === "night-pause") {
      const data = await readRppNightPauseProducts();
      return Response.json({ ok: true, itemCodes: data.itemCodes });
    }
    if (searchParams.get("resource") === "delivery-schedules") {
      const data = await readRppDeliverySchedules();
      const pendingReservations = await readPendingRppDeliveryReservations();
      const targetData = await readRppAlertTargets();
      const savedIds = new Set(targetData.targets.map((row) => row.id));
      const byItem = new Map<string, { total: number; saved: number }>();
      for (const row of targetData.configuredTargets) {
        const current = byItem.get(row.itemCode) ?? { total: 0, saved: 0 };
        current.total += 1;
        if (savedIds.has(row.id)) current.saved += 1;
        byItem.set(row.itemCode, current);
      }
      return Response.json({
        ok: true,
        timeZone: "Asia/Tokyo",
        schedules: data.schedules.map((row) => ({
          itemCode: row.itemCode,
          enabled: row.recurring.enabled,
          startTime: row.recurring.startTime,
          endTime: row.recurring.endTime,
          updatedAt: row.updatedAt,
        })),
        reservations: pendingReservations,
        releaseAllowedItemCodes: [...byItem.entries()].filter(([, count]) => count.total > 0 && count.saved === count.total).map(([itemCode]) => itemCode).sort(),
      });
    }
    const snapshot = await readLatestRppDashboardSnapshot();
    return Response.json({ ok: true, snapshot });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    if (new URL(request.url).searchParams.get("resource") === "delivery-schedules") {
      if (body.operation === "CLAIM") {
        const { reservation } = await claimRppDeliveryReservation(body.reservationId);
        return Response.json({ ok: true, reservation });
      }
      const { reservation } = await markRppDeliveryReservation(body.reservationId, body.claimId, body.status, body.error);
      return Response.json({ ok: true, reservation });
    }
    const snapshot = await saveRppDashboardSnapshot(body);
    return Response.json({ ok: true, syncedAt: snapshot.syncedAt, recommendationCount: snapshot.recommendations.recommendations.length }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
