import { spawn } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RPP_PROJECT_DIR = process.env.RPP_PROJECT_DIR ?? "/Users/nob/Projects/rpp-8am-notify";

function runApply() {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const scriptPath = path.join(/* turbopackIgnore: true */ RPP_PROJECT_DIR, "rpp_apply_approved_cpc_upload.js");
    // Dashboardからは安全のためdry-run/空承認チェックのみ。
    // 本番反映はCLIで --execute + env + confirm + final-submit を明示した場合のみ。
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
  const result = await runApply();
  if (result.code !== 0) {
    return Response.json({ ok: false, error: result.stderr || result.stdout, code: result.code }, { status: 500 });
  }
  try {
    return Response.json(JSON.parse(result.stdout));
  } catch {
    return Response.json({ ok: true, raw: result.stdout });
  }
}
