import {
  cancelRppDeliveryReservation,
  createRppDeliveryReservation,
  jstLocalDateTimeToIso,
  normalizeRppDeliveryItemCode,
  RppDeliveryScheduleConflictError,
  readRppDeliverySchedules,
  rppDeliveryStorageStatus,
  rppRmsEffectiveStateObservation,
  summarizeRppDeliverySchedule,
  withRppDeliveryReservationRuntimeStatus,
  writeRppRecurringSchedule,
} from "@/lib/rppDeliverySchedules";
import {
  assessRppDeliveryReservation,
  rppDeliveryWarningKeysMatch,
  type RppDeliveryWarning,
} from "@/lib/rppDeliveryScheduleWarnings";
import { appendRppAuditEvent } from "@/lib/rppAuditLog";
import { requireRppRole } from "@/lib/rppRouteAuth";
import { readRppAlertTargets, readRppProductCpcItemCodes } from "@/lib/rppTargets";
import { readRppNightPauseProducts } from "@/lib/rppNightPause";
import { readLatestRppDashboardSnapshot } from "@/lib/rppDashboardSnapshots";

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
  if (error instanceof RppDeliveryOverlapError) {
    return Response.json({ error: error.message, code: error.code, warnings: error.warnings }, { status: 409 });
  }
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof RppDeliveryScheduleConflictError ? 409 : 400 });
}

class RppDeliveryOverlapError extends Error {
  constructor(public code: "OVERLAP_BLOCKED" | "OVERLAP_CONFIRMATION_REQUIRED", public warnings: RppDeliveryWarning[]) {
    super(code === "OVERLAP_BLOCKED" ? warnings[0]?.message ?? "時間指定が競合しています" : "警告内容を確認してからもう一度保存してください");
    this.name = "RppDeliveryOverlapError";
  }
}

function requireAcknowledgedWarnings(warnings: RppDeliveryWarning[], acknowledgedInput: unknown) {
  if (!rppDeliveryWarningKeysMatch(warnings, acknowledgedInput)) {
    throw new RppDeliveryOverlapError("OVERLAP_CONFIRMATION_REQUIRED", warnings);
  }
}

async function assessReservations(
  itemCode: string,
  recurring: { enabled: boolean; startTime: string; endTime: string } | undefined,
  reservations: { action: "ON" | "OFF"; executeAt: string; status?: string }[],
) {
  const legacySelection = await readRppNightPauseProducts();
  const windows = [
    { recurring, sourceKey: "CUSTOM", sourceLabel: "毎日停止" },
    ...(legacySelection.itemCodes.includes(itemCode)
      ? [{ recurring: { enabled: true, startTime: "01:30", endTime: "06:00" }, sourceKey: "LEGACY", sourceLabel: "旧夜間停止" }]
      : []),
  ];
  const activeReservations = reservations.filter((reservation) => !reservation.status || ["PENDING", "RUNNING"].includes(reservation.status));
  return activeReservations.flatMap((reservation) => windows.map((window) =>
    assessRppDeliveryReservation(window.recurring, reservation, window.sourceKey, window.sourceLabel)));
}

function warningMessages(assessments: Awaited<ReturnType<typeof assessReservations>>) {
  return [...new Set(assessments.flatMap((assessment) => [
    ...(assessment.blocked ? [assessment.blocked.message] : []),
    ...assessment.warnings.map((warning) => warning.message),
  ]))];
}

export async function GET(request: Request) {
  const access = await requireRppRole("viewer");
  if (!access.ok) return access.response;
  const itemCode = normalizeRppDeliveryItemCode(new URL(request.url).searchParams.get("itemCode"));
  const [data, snapshot] = await Promise.all([
    readRppDeliverySchedules({ itemCode: itemCode || undefined, reservationLimitPerItem: 100 }),
    readLatestRppDashboardSnapshot(),
  ]);
  const storage = rppDeliveryStorageStatus(data.source);
  if (process.env.NODE_ENV === "production" && !storage.durable) throw new Error("RPP delivery schedule storage is not PostgreSQL");
  const now = new Date();
  const reservations = data.reservations.map((row) => withRppDeliveryReservationRuntimeStatus(row, now));
  const itemCodes = new Set([...data.schedules.map((row) => row.itemCode), ...data.reservations.map((row) => row.itemCode)]);
  if (itemCode) itemCodes.add(itemCode);
  const statuses = [...itemCodes].map((code) => summarizeRppDeliverySchedule(
    data.schedules.find((row) => row.itemCode === code),
    data.reservations.filter((row) => row.itemCode === code),
    now,
    rppRmsEffectiveStateObservation(code, snapshot?.rppData?.exclusionProducts, snapshot?.rppData?.exclusionObservation, now),
    code,
  ));
  const warnings = itemCode
    ? warningMessages(await assessReservations(itemCode, data.schedules.find((row) => row.itemCode === itemCode)?.recurring, reservations))
    : [];
  if (!itemCode) return Response.json({ ok: true, ...data, storage, reservations, statuses, warnings, historyLimitPerItem: 100 });
  return Response.json({
    ok: true,
    ...data,
    storage,
    reservations,
    statuses,
    warnings,
    historyLimitPerItem: 100,
  });
}

export async function PATCH(request: Request) {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
  try {
    const body = await request.json() as { itemCode?: unknown; enabled?: unknown; startTime?: unknown; endTime?: unknown; expectedUpdatedAt?: unknown; acknowledgedWarningKeys?: unknown };
    const itemCode = await requireExistingRppProduct(body.itemCode);
    if (body.enabled === true) await requireReleaseAllowed(itemCode);
    const beforeData = await readRppDeliverySchedules({ itemCode, reservationLimitPerItem: 100 });
    const before = beforeData.schedules[0] ?? null;
    const recurring = { enabled: body.enabled as boolean, startTime: String(body.startTime ?? ""), endTime: String(body.endTime ?? "") };
    const assessments = await assessReservations(itemCode, recurring, beforeData.reservations.filter((row) => row.status === "PENDING"));
    for (const assessment of assessments) {
      if (assessment.blocked) throw new RppDeliveryOverlapError("OVERLAP_BLOCKED", [{ key: assessment.blocked.key, message: assessment.blocked.message }]);
    }
    requireAcknowledgedWarnings(assessments.flatMap((assessment) => assessment.warnings), body.acknowledgedWarningKeys);
    const data = await writeRppRecurringSchedule(itemCode, {
      ...recurring,
    }, body.expectedUpdatedAt, { email: access.email, name: access.name });
    const schedule = data.schedules.find((row) => row.itemCode === itemCode);
    const current = await readRppDeliverySchedules({ itemCode, reservationLimitPerItem: 100 });
    const warnings = warningMessages(await assessReservations(itemCode, schedule?.recurring, current.reservations));
    await appendRppAuditEvent("DELIVERY_RECURRING_SCHEDULE_SAVED", itemCode, { actorName: access.name, before, after: schedule }, access.email, { entityType: "delivery-schedule" });
    return Response.json({ ok: true, ...data, schedule, warnings });
  } catch (error) {
    return badRequest(error);
  }
}

export async function POST(request: Request) {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
  try {
    const body = await request.json() as { itemCode?: unknown; action?: unknown; executeAt?: unknown; timeZone?: unknown; acknowledgedWarningKeys?: unknown };
    const itemCode = await requireExistingRppProduct(body.itemCode);
    if (body.action === "ON") await requireReleaseAllowed(itemCode);
    const currentBefore = await readRppDeliverySchedules({ itemCode, reservationLimitPerItem: 0 });
    const candidate = { action: body.action as "ON" | "OFF", executeAt: jstLocalDateTimeToIso(body.executeAt, body.timeZone) };
    const assessments = await assessReservations(itemCode, currentBefore.schedules[0]?.recurring, [candidate]);
    const blocked = assessments.find((assessment) => assessment.blocked)?.blocked;
    if (blocked) throw new RppDeliveryOverlapError("OVERLAP_BLOCKED", [{ key: blocked.key, message: blocked.message }]);
    requireAcknowledgedWarnings(assessments.flatMap((assessment) => assessment.warnings), body.acknowledgedWarningKeys);
    const result = await createRppDeliveryReservation(itemCode, body.action, body.executeAt, body.timeZone);
    const current = await readRppDeliverySchedules({ itemCode, reservationLimitPerItem: 100 });
    const warnings = warningMessages(await assessReservations(itemCode, current.schedules[0]?.recurring, current.reservations));
    await appendRppAuditEvent("DELIVERY_RESERVATION_CREATED", result.reservation.id, { actorName: access.name, reservation: result.reservation }, access.email, { entityType: "delivery-reservation" });
    return Response.json({ ok: true, ...result, warnings }, { status: 201 });
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
