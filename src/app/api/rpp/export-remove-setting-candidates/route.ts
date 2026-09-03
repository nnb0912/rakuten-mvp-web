import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { requireRppRole } from "@/lib/rppRouteAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RPP_PROJECT_DIR = process.env.RPP_PROJECT_DIR ?? "/Users/nob/Projects/rpp-8am-notify";
const HISTORY_PATH = path.join(/* turbopackIgnore: true */ RPP_PROJECT_DIR, "rpp_uploads", "remove_setting_export_history.json");

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

function readHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
  return Array.isArray(parsed) ? parsed.slice(0, 10) : [];
}

function writeHistory(history: unknown[]) {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, `${JSON.stringify(history.slice(0, 50), null, 2)}\n`);
}

export async function GET() {
  const access = await requireRppRole("viewer");
  if (!access.ok) return access.response;
  try {
    return Response.json({ ok: true, productionChange: false, history: readHistory() });
  } catch (e) {
    return Response.json({ ok: false, productionChange: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST() {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
  const result = await runExport();
  if (result.code !== 0) {
    return Response.json({ ok: false, error: result.stderr || result.stdout, code: result.code }, { status: 500 });
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return Response.json({ ok: true, productionChange: false, ...parsed, historyRows: readHistory() });
  } catch {
    return Response.json({ ok: true, productionChange: false, raw: result.stdout });
  }
}

export async function DELETE() {
  const access = await requireRppRole("operator");
  if (!access.ok) return access.response;
  try {
    const history = readHistory();
    if (!history.length) return Response.json({ ok: true, productionChange: false, history: [] });
    const [latest, ...rest] = history;
    const unlocked = { ...latest, dryRun: undefined, fixedClearedAt: new Date().toISOString() };
    writeHistory([unlocked, ...rest]);
    return Response.json({ ok: true, productionChange: false, history: readHistory() });
  } catch (e) {
    return Response.json({ ok: false, productionChange: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
