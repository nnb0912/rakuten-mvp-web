import {
  finishRppExperiment,
  readRppExperimentHistory,
  startRppExperiment,
  type FinishRppExperimentInput,
  type StartRppExperimentInput,
} from "@/lib/rppExperiments";
import { requireRppRole } from "@/lib/rppRouteAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const access = await requireRppRole("viewer");
  if (!access.ok) return access.response;
  try {
    const targetId = new URL(request.url).searchParams.get("targetId")?.trim() || undefined;
    const experiments = await readRppExperimentHistory({ targetId });
    return Response.json({ experiments, count: experiments.length });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
  try {
    const body = await request.json() as StartRppExperimentInput;
    const experiment = await startRppExperiment(body);
    return Response.json({ ok: true, experiment }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
  try {
    const body = await request.json() as FinishRppExperimentInput & { id?: string };
    const experiment = await finishRppExperiment(body.id || "", body);
    return Response.json({ ok: true, experiment });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("見つかりません") ? 404 : message.includes("すでに終了") ? 409 : 400;
    return Response.json({ error: message }, { status });
  }
}
