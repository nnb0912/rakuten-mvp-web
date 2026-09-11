import { timingSafeEqual } from "crypto";
import { readLatestRppDashboardSnapshot, saveRppDashboardSnapshot } from "@/lib/rppDashboardSnapshots";
import { claimRppDeliveryReservation, heartbeatRppDeliveryReservation, markRppDeliveryReservation, readPendingRppDeliveryReservations, readRppDeliverySchedules, releaseRppDeliveryReservationClaim } from "@/lib/rppDeliverySchedules";
import { readRppNightPauseProducts } from "@/lib/rppNightPause";
import { readRppAlertTargets, readRppConfiguredTargets, readRppProductCpcItemCodes } from "@/lib/rppTargets";

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
      const data = await readRppDeliverySchedules({ reservationLimitPerItem: 0 });
      const pendingReservations = await readPendingRppDeliveryReservations();
      const targetData = await readRppAlertTargets();
      const releaseConfiguredTargets = await readRppConfiguredTargets({ includeExcluded: true });
      const validItemCodes = new Set(await readRppProductCpcItemCodes());
      if (validItemCodes.size === 0 && (data.schedules.length > 0 || pendingReservations.length > 0)) {
        throw new Error("authoritative RPP product list is unavailable; delivery scheduling is fail-closed");
      }
      const orphanedSchedules = data.schedules.filter((row) => !validItemCodes.has(row.itemCode));
      const orphanedReservations = pendingReservations.filter((row) => !validItemCodes.has(row.itemCode));
      const executableSchedules = data.schedules.filter((row) => validItemCodes.has(row.itemCode));
      const executableReservations = pendingReservations.filter((row) => validItemCodes.has(row.itemCode));
      const orphanedRestoreReservations = orphanedReservations.filter((row) => row.action === "ON").map((row) => ({ ...row, orphaned: true }));
      const savedIds = new Set(targetData.targets.map((row) => row.id));
      const byItem = new Map<string, { total: number; saved: number }>();
      for (const row of releaseConfiguredTargets) {
        const current = byItem.get(row.itemCode) ?? { total: 0, saved: 0 };
        current.total += 1;
        if (savedIds.has(row.id)) current.saved += 1;
        byItem.set(row.itemCode, current);
      }
      const normalReleaseAllowed = [...byItem.entries()].filter(([, count]) => count.total > 0 && count.saved === count.total).map(([itemCode]) => itemCode);
      return Response.json({
        ok: true,
        timeZone: "Asia/Tokyo",
        schedules: executableSchedules.map((row) => ({
          itemCode: row.itemCode,
          enabled: row.recurring.enabled,
          startTime: row.recurring.startTime,
          endTime: row.recurring.endTime,
          updatedAt: row.updatedAt,
        })),
        reservations: [...executableReservations, ...orphanedRestoreReservations].sort((a, b) => a.executeAt.localeCompare(b.executeAt)),
        orphanedSchedules,
        orphanedReservations,
        releaseAllowedItemCodes: [...new Set([
          ...normalReleaseAllowed,
          ...orphanedSchedules.map((row) => row.itemCode),
          ...orphanedRestoreReservations.map((row) => row.itemCode),
        ])].sort(),
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
      if (body.operation === "HEARTBEAT") {
        const { reservation } = await heartbeatRppDeliveryReservation(body.reservationId, body.claimId);
        return Response.json({ ok: true, reservation });
      }
      if (body.operation === "RELEASE") {
        const { reservation } = await releaseRppDeliveryReservationClaim(body.reservationId, body.claimId, body.error);
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
