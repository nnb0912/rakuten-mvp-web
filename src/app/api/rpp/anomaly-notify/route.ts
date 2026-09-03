import { requireRppRole } from "@/lib/rppRouteAuth";
import { appendRppAuditEvent } from "@/lib/rppAuditLog";
import { evaluateChatworkDelivery, formatRppAnomalyMessage, type RppAnomaly } from "@/lib/rppAnomalyAlerts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const allowedTypes = new Set(["CPC_SPIKE", "ROAS_DROP", "SPEND_SPIKE", "DATA_MISSING", "DATA_STALE", "COUNT_MISMATCH"]);

function normalizeAnomalies(value: unknown): RppAnomaly[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const input = row as Record<string, unknown>;
    if (!allowedTypes.has(String(input.type))) return [];
    return [{
      type: String(input.type) as RppAnomaly["type"],
      severity: input.severity === "CRITICAL" ? "CRITICAL" as const : "WARNING" as const,
      label: String(input.label ?? "異常").slice(0, 80),
      detail: String(input.detail ?? "").slice(0, 300),
    }];
  });
}

async function sendAndReadBack(message: string, token: string, room: string) {
  const sendResponse = await fetch(`https://api.chatwork.com/v2/rooms/${encodeURIComponent(room)}/messages`, {
    method: "POST",
    headers: { "X-ChatWorkToken": token, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ body: message }),
  });
  const sendText = await sendResponse.text();
  if (!sendResponse.ok) throw new Error(`Chatwork送信失敗 status=${sendResponse.status}`);
  const messageId = String((JSON.parse(sendText) as { message_id?: string }).message_id ?? "");
  if (!messageId) throw new Error("Chatwork message_idなし");
  const readResponse = await fetch(`https://api.chatwork.com/v2/rooms/${encodeURIComponent(room)}/messages/${encodeURIComponent(messageId)}`, { headers: { "X-ChatWorkToken": token } });
  const readText = await readResponse.text();
  if (!readResponse.ok) throw new Error(`Chatwork読み戻し失敗 status=${readResponse.status}`);
  const readback = JSON.parse(readText) as { body?: string };
  if (readback.body !== message) throw new Error("Chatwork読み戻し本文不一致");
  return { messageId, readbackVerified: true };
}

export async function POST(request: Request) {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
  const body = await request.json() as { anomalies?: unknown; send?: boolean };
  if (body.send === true && access.role !== "admin") {
    return Response.json({ error: "forbidden", requiredRole: "admin" }, { status: 403 });
  }
  const anomalies = normalizeAnomalies(body.anomalies);
  const message = formatRppAnomalyMessage(anomalies);
  const token = process.env.CHATWORK_API_TOKEN ?? "";
  const room = process.env.RPP_CHATWORK_ROOM_ID ?? process.env.CHATWORK_ROOM_ID ?? "";
  const decision = evaluateChatworkDelivery({ requestedSend: body.send === true, sendEnabled: process.env.RPP_CHATWORK_SEND_ENABLED === "true", tokenPresent: Boolean(token), roomPresent: Boolean(room) });
  const operationId = crypto.randomUUID();
  if (!decision.canSend) {
    await appendRppAuditEvent("ANOMALY_CHATWORK_PREVIEW", "Chatwork異常通知", { anomalyCount: anomalies.length, mode: decision.mode, reason: decision.reason, productionChange: false }, access.email, { operationId, status: decision.mode === "BLOCKED" ? "blocked" : "verified", productionChange: false, entityType: "notification" });
    return Response.json({ ok: decision.mode === "DRY_RUN", sent: false, productionChange: false, ...decision, anomalyCount: anomalies.length, preview: message }, { status: decision.mode === "BLOCKED" ? 400 : 200 });
  }
  try {
    const result = await sendAndReadBack(message, token, room);
    await appendRppAuditEvent("ANOMALY_CHATWORK_SENT", "Chatwork異常通知", { anomalyCount: anomalies.length, ...result, productionChange: false }, access.email, { operationId, status: "verified", productionChange: false, entityType: "notification" });
    return Response.json({ ok: true, sent: true, productionChange: false, mode: decision.mode, anomalyCount: anomalies.length, ...result });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await appendRppAuditEvent("ANOMALY_CHATWORK_FAILED", "Chatwork異常通知", { anomalyCount: anomalies.length, error: detail, productionChange: false }, access.email, { operationId, status: "failed", productionChange: false, entityType: "notification" });
    return Response.json({ ok: false, sent: false, productionChange: false, error: detail }, { status: 502 });
  }
}
