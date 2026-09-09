import { readRppNightPauseProducts, normalizeRppNightPauseItemCode, writeRppNightPauseProduct } from "@/lib/rppNightPause";
import { requireRppRole } from "@/lib/rppRouteAuth";
import { readRppExclusionProducts } from "@/lib/rppTargets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const access = await requireRppRole("viewer");
  if (!access.ok) return access.response;
  return Response.json({ ok: true, ...await readRppNightPauseProducts() });
}

export async function POST(request: Request) {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;

  try {
    const body = await request.json() as { itemCode?: unknown; enabled?: unknown };
    const itemCode = normalizeRppNightPauseItemCode(body.itemCode);
    if (!itemCode) throw new Error("商品管理番号は必須です");
    if (typeof body.enabled !== "boolean") throw new Error("enabledはbooleanで指定してください");

    const products = await readRppExclusionProducts();
    if (!products.some((row) => normalizeRppNightPauseItemCode(row.itemCode) === itemCode)) {
      throw new Error(`RPP商品が見つかりません: ${itemCode}`);
    }

    const saved = await writeRppNightPauseProduct(itemCode, body.enabled);
    return Response.json({ ok: true, ...saved });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
