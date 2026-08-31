import { auth } from "@/auth";
import { readRppBudgetSettings, writeRppBudgetSettings, type RppBudgetSettings } from "@/lib/rppBudgetSettings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json(await readRppBudgetSettings());
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const result = await writeRppBudgetSettings(await request.json() as Partial<RppBudgetSettings>, session.user.email);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
