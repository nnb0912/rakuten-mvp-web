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
    const body = (await request.json()) as { changes?: ExclusionChange[]; execute?: boolean; finalSubmit?: boolean };
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
        ok: true,
        productionChange: false,
        disabled: true,
        reason: "RMS自動反映はサーバー側で無効です。CSVのみ生成しました。",
        csvPath,
        changes: changes.length,
      });
    }

    const appRoot = /* turbopackIgnore: true */ process.cwd();
    const projectRoot = /* turbopackIgnore: true */ RPP_PROJECT_DIR;
    const scriptCandidates = [
      { command: "node", path: path.join(appRoot, "scripts", "rpp_apply_exclusion_upload.mjs") },
      { command: "python3", path: path.join(appRoot, "scripts", "rpp_apply_exclusion_upload.py") },
      { command: "python3", path: path.join(projectRoot, "rpp_apply_exclusion_upload.py") },
    ];
    let script = scriptCandidates[0];
    for (const candidate of scriptCandidates) {
      try {
        await fs.access(candidate.path);
        script = candidate;
        break;
      } catch {
        // Try the next bundled/project script.
      }
    }
    try {
      await fs.access(script.path);
    } catch {
      return Response.json({
        error: "RMS自動反映ONですが、アップロード処理がサーバーに未配置です。CSVのみ生成しました。",
        csvPath,
        changes: changes.length,
        productionChange: false,
        missingScript: scriptCandidates.map((candidate) => candidate.path),
      }, { status: 501 });
    }

    const finalSubmit = body.finalSubmit !== false;
    const runHelper = finalSubmit
      ? "exec \"$RPP_UPLOAD_COMMAND\" \"$RPP_UPLOAD_SCRIPT\" --csv \"$RPP_UPLOAD_CSV\" --execute --final-submit --confirm=RMS_EXCLUSION_UPLOAD"
      : "exec \"$RPP_UPLOAD_COMMAND\" \"$RPP_UPLOAD_SCRIPT\" --csv \"$RPP_UPLOAD_CSV\" --execute";
    const installBrowser = script.command === "node"
      ? "if ! ls /opt/render/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell >/dev/null 2>&1; then npx playwright install chromium >/tmp/rpp_playwright_install.log 2>&1; fi && "
      : "";
    const childArgs = ["-lc", `${installBrowser}${runHelper}`];
    const child = spawn("bash", childArgs, {
      cwd: RPP_PROJECT_DIR,
      env: { ...process.env, RPP_UPLOAD_COMMAND: script.command, RPP_UPLOAD_SCRIPT: script.path, RPP_UPLOAD_CSV: csvPath },
    });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { errorOutput += chunk.toString(); });
    const exitCode: number = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        errorOutput += "\nRMS upload helper timed out after 480 seconds";
        child.kill("SIGTERM");
      }, 480_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        errorOutput += `\n${error instanceof Error ? error.message : String(error)}`;
        resolve(1);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });
    if (exitCode !== 0) {
      return Response.json({ error: "RMS反映に失敗しました", exitCode, output, errorOutput, csvPath, helper: script.command }, { status: 500 });
    }
    return Response.json({ ok: true, productionChange: finalSubmit, csvPath, changes: changes.length, output, helper: script.command });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
