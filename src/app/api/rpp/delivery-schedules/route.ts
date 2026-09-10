import {
  cancelRppDeliveryReservation,
  createRppDeliveryReservation,
  normalizeRppDeliveryItemCode,
  readRppDeliverySchedules,
  writeRppRecurringSchedule,
} from "@/lib/rppDeliverySchedules";
import { requireRppRole } from "@/lib/rppRouteAuth";
import { readRppAlertTargets, readRppConfiguredTargets } from "@/lib/rppTargets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function requireExistingRppProduct(itemCodeInput: unknown) {
  const itemCode = normalizeRppDeliveryItemCode(itemCodeInput);
  if (!itemCode) throw new Error("商品管理番号は必須です");
  const targets = await readRppConfiguredTargets();
  if (!targets.some((row) => row.source === "商品CPC" && normalizeRppDeliveryItemCode(row.itemCode) === itemCode)) {
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
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
}

export async function GET(request: Request) {
  const access = await requireRppRole("viewer");
  if (!access.ok) return access.response;
  const data = await readRppDeliverySchedules();
  const itemCode = normalizeRppDeliveryItemCode(new URL(request.url).searchParams.get("itemCode"));
  if (!itemCode) return Response.json({ ok: true, ...data });
  return Response.json({
    ok: true,
    ...data,
    schedules: data.schedules.filter((row) => row.itemCode === itemCode),
    reservations: data.reservations.filter((row) => row.itemCode === itemCode),
  });
}

export async function PATCH(request: Request) {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
  try {
    const body = await request.json() as { itemCode?: unknown; enabled?: unknown; startTime?: unknown; endTime?: unknown };
    const itemCode = await requireExistingRppProduct(body.itemCode);
    if (body.enabled === true) await requireReleaseAllowed(itemCode);
    const data = await writeRppRecurringSchedule(itemCode, {
      enabled: body.enabled as boolean,
      startTime: String(body.startTime ?? ""),
      endTime: String(body.endTime ?? ""),
    });
    return Response.json({ ok: true, ...data, schedule: data.schedules.find((row) => row.itemCode === itemCode) });
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
    return Response.json({ ok: true, ...await cancelRppDeliveryReservation(body.reservationId, itemCode) });
  } catch (error) {
    return badRequest(error);
  }
}
