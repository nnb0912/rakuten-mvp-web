import {
  cancelRppDeliveryReservation,
  createRppDeliveryReservation,
  normalizeRppDeliveryItemCode,
  RppDeliveryScheduleConflictError,
  readRppDeliverySchedules,
  summarizeRppDeliverySchedule,
  withRppDeliveryReservationRuntimeStatus,
  writeRppRecurringSchedule,
} from "@/lib/rppDeliverySchedules";
import { appendRppAuditEvent } from "@/lib/rppAuditLog";
import { requireRppRole } from "@/lib/rppRouteAuth";
import { readRppAlertTargets, readRppProductCpcItemCodes } from "@/lib/rppTargets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function requireExistingRppProduct(itemCodeInput: unknown) {
  const itemCode = normalizeRppDeliveryItemCode(itemCodeInput);
  if (!itemCode) throw new Error("商品管理番号は必須です");
  const itemCodes = await readRppProductCpcItemCodes();
  if (!itemCodes.includes(itemCode)) {
    throw new Error(`商品CPC行が見つかりません: ${itemCode}`);
  }
  return itemCode;
}

async function requireReleaseAllowed(itemCode: string) {
  const data = await readRppAlertTargets();
  const configured = data.configuredTargets.filter((row) => normalizeRppDeliveryItemCode(row.itemCode) === itemCode);
  const savedIds = new Set(data.targets.map((row) => row.id));
  if (!configured.length || configured.some((row) => !savedIds.has(row.id))) {
    throw new Error("広告ON予約には、この商品の全RPP設定行への目標保存が必要です");
  }
}

function badRequest(error: unknown) {
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof RppDeliveryScheduleConflictError ? 409 : 400 });
}

export async function GET(request: Request) {
  const access = await requireRppRole("viewer");
  if (!access.ok) return access.response;
  const itemCode = normalizeRppDeliveryItemCode(new URL(request.url).searchParams.get("itemCode"));
  const data = await readRppDeliverySchedules({ itemCode: itemCode || undefined, reservationLimitPerItem: 100 });
  const now = new Date();
  const reservations = data.reservations.map((row) => withRppDeliveryReservationRuntimeStatus(row, now));
  const itemCodes = new Set([...data.schedules.map((row) => row.itemCode), ...data.reservations.map((row) => row.itemCode)]);
  const statuses = [...itemCodes].map((code) => summarizeRppDeliverySchedule(data.schedules.find((row) => row.itemCode === code), data.reservations.filter((row) => row.itemCode === code), now));
  if (!itemCode) return Response.json({ ok: true, ...data, reservations, statuses, historyLimitPerItem: 100 });
  return Response.json({
    ok: true,
    ...data,
    reservations,
    statuses,
    historyLimitPerItem: 100,
  });
}

export async function PATCH(request: Request) {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
  try {
    const body = await request.json() as { itemCode?: unknown; enabled?: unknown; startTime?: unknown; endTime?: unknown; expectedUpdatedAt?: unknown };
    const itemCode = await requireExistingRppProduct(body.itemCode);
    if (body.enabled === true) await requireReleaseAllowed(itemCode);
    const before = (await readRppDeliverySchedules({ itemCode, reservationLimitPerItem: 0 })).schedules[0] ?? null;
    const data = await writeRppRecurringSchedule(itemCode, {
      enabled: body.enabled as boolean,
      startTime: String(body.startTime ?? ""),
      endTime: String(body.endTime ?? ""),
    }, body.expectedUpdatedAt, { email: access.email, name: access.name });
    const schedule = data.schedules.find((row) => row.itemCode === itemCode);
    await appendRppAuditEvent("DELIVERY_RECURRING_SCHEDULE_SAVED", itemCode, { actorName: access.name, before, after: schedule }, access.email, { entityType: "delivery-schedule" });
    return Response.json({ ok: true, ...data, schedule });
  } catch (error) {
    return badRequest(error);
  }
}

export async function POST(request: Request) {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
  try {
    const body = await request.json() as { itemCode?: unknown; action?: unknown; executeAt?: unknown; timeZone?: unknown };
    const itemCode = await requireExistingRppProduct(body.itemCode);
    if (body.action === "ON") await requireReleaseAllowed(itemCode);
    const result = await createRppDeliveryReservation(itemCode, body.action, body.executeAt, body.timeZone);
    await appendRppAuditEvent("DELIVERY_RESERVATION_CREATED", result.reservation.id, { actorName: access.name, reservation: result.reservation }, access.email, { entityType: "delivery-reservation" });
    return Response.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    return badRequest(error);
  }
}

export async function DELETE(request: Request) {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
  try {
    const body = await request.json() as { reservationId?: unknown; itemCode?: unknown };
    const itemCode = normalizeRppDeliveryItemCode(body.itemCode);
    if (!itemCode) throw new Error("商品管理番号は必須です");
    const result = await cancelRppDeliveryReservation(body.reservationId, itemCode);
    await appendRppAuditEvent("DELIVERY_RESERVATION_CANCELLED", result.reservation.id, { actorName: access.name, reservation: result.reservation }, access.email, { entityType: "delivery-reservation" });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return badRequest(error);
  }
}
