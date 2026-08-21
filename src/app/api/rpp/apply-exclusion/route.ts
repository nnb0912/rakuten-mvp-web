import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_RPP_PROJECT_DIR = "/Users/nob/Projects/rpp-8am-notify";
const RPP_PROJECT_DIR = process.env.RPP_PROJECT_DIR ?? (process.platform === "darwin" ? DEFAULT_RPP_PROJECT_DIR : "/var/data/rpp-8am-notify");

function csvCell(value: string) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

type ExclusionChange = { itemCode: string; currentExcluded: boolean; originalExcluded?: boolean };

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { changes?: ExclusionChange[]; execute?: boolean };
    const changes = (body.changes ?? []).filter((row) => row.itemCode && row.currentExcluded !== row.originalExcluded);
    if (!changes.length) return Response.json({ error: "変更対象がありません" }, { status: 400 });

    const uploadDir = path.join(RPP_PROJECT_DIR, "rpp_uploads");
    await fs.mkdir(uploadDir, { recursive: true });
    const ymd = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const csvPath = path.join(uploadDir, `rpp_exclude_diff_${ymd}_${Date.now()}.csv`);
    const lines = [
      '"コントロールカラム","商品管理番号"',
      ...changes.map((row) => `${csvCell(row.currentExcluded ? "n" : "d")},${csvCell(row.itemCode)}`),
    ];
    await fs.writeFile(csvPath, `${lines.join("\r\n")}\r\n`, "utf8");

    if (!body.execute) {
      return Response.json({ ok: true, dryRun: true, csvPath, changes: changes.length });
    }

    if (process.env.RPP_ENABLE_RMS_EXCLUSION_UPLOAD !== "1") {
      return Response.json({
        error: "RMS自動反映はサーバー側で無効です。RPP_ENABLE_RMS_EXCLUSION_UPLOAD=1 が必要です。",
        csvPath,
        changes: changes.length,
      }, { status: 412 });
    }

    const scriptPath = path.join(RPP_PROJECT_DIR, "rpp_apply_exclusion_upload.py");
    const child = spawn("python3", [scriptPath, "--csv", csvPath, "--execute"], { cwd: RPP_PROJECT_DIR, env: process.env });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { errorOutput += chunk.toString(); });
    const exitCode: number = await new Promise((resolve) => child.on("close", resolve));
    if (exitCode !== 0) {
      return Response.json({ error: "RMS反映に失敗しました", exitCode, output, errorOutput, csvPath }, { status: 500 });
    }
    return Response.json({ ok: true, productionChange: true, csvPath, changes: changes.length, output });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
