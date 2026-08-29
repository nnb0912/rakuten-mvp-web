import { spawn } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RPP_PROJECT_DIR = process.env.RPP_PROJECT_DIR ?? "/Users/nob/Projects/rpp-8am-notify";

function runExport() {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const scriptPath = path.join(/* turbopackIgnore: true */ RPP_PROJECT_DIR, "rpp_export_remove_setting_candidates.js");
    const child = spawn(process.execPath, [scriptPath], {
      cwd: RPP_PROJECT_DIR,
      env: { ...process.env, RPP_ENABLE_PRODUCTION_UPLOAD: "0" },
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
  const result = await runExport();
  if (result.code !== 0) {
    return Response.json({ ok: false, error: result.stderr || result.stdout, code: result.code }, { status: 500 });
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return Response.json({ ok: true, productionChange: false, ...parsed });
  } catch {
    return Response.json({ ok: true, productionChange: false, raw: result.stdout });
  }
}
