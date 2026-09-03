import { spawn } from "child_process";
import path from "path";
import { requireRppRole } from "@/lib/rppRouteAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RPP_PROJECT_DIR = process.env.RPP_PROJECT_DIR ?? "/Users/nob/Projects/rpp-8am-notify";

function runExport() {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const scriptPath = path.join(/* turbopackIgnore: true */ RPP_PROJECT_DIR, "rpp_export_approved_cpc_csv.js");
    const child = spawn(process.execPath, [scriptPath], {
      cwd: RPP_PROJECT_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

export async function POST() {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
  const result = await runExport();
  if (result.code !== 0) {
    return Response.json({ ok: false, error: result.stderr || result.stdout, code: result.code }, { status: 500 });
  }
  try {
    return Response.json(JSON.parse(result.stdout));
  } catch {
    return Response.json({ ok: true, raw: result.stdout });
  }
}
