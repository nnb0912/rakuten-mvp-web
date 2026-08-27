import { promises as fs } from "fs";
import path from "path";

export type RppApprovalStatus = "pending" | "approved" | "rejected" | "held";

export type RppRecommendation = {
  date: string;
  itemCode: string;
  itemName: string;
  keyword: string;
  direction: "up" | "down";
  action: "RAISE" | "LOWER" | "HOLD";
  currentCpc: number;
  meyasuCpc: number;
  proposedCpc: number | null;
  delta: number | null;
  source: string;
  clicks: number | null;
  spend: number | null;
  salesAmount: number | null;
  roas: number | null;
  cvr: number | null;
  rppPosition: string;
  reasons: string[];
  blocks: string[];
  uploadReady: boolean;
  note: string;
};

export type RppRecommendationWithApproval = RppRecommendation & {
  id: string;
  approvalStatus: RppApprovalStatus;
  approvalNote: string | null;
  approvedAt: string | null;
};

type RecommendationFile = {
  summary: Record<string, unknown>;
  recommendations: RppRecommendation[];
};

type ApprovalRecord = {
  status: RppApprovalStatus;
  note?: string;
  updatedAt: string;
};

type ApprovalFile = Record<string, ApprovalRecord>;

const RPP_PROJECT_DIR = process.env.RPP_PROJECT_DIR ?? "/Users/nob/Projects/rpp-8am-notify";
const RECOMMENDATION_DIR = path.join(RPP_PROJECT_DIR, "rpp_recommendations");
const UPLOAD_DIR = path.join(RPP_PROJECT_DIR, "rpp_uploads");
const APPLY_LOG_PATH = path.join(RPP_PROJECT_DIR, "rpp_apply_logs", "rpp_apply_history.json");
const RPP_LOG_DIR = path.join(RPP_PROJECT_DIR, "rpp_logs");
const CHATWORK_LAST_READBACK_PATH = path.join(RPP_LOG_DIR, "chatwork_last_send_readback.json");
const APPROVAL_PATH = path.join(RECOMMENDATION_DIR, "rpp_auto_approvals.json");
const SNAPSHOT_RECOMMENDATIONS_PATH = path.join(process.cwd(), "src", "data", "rpp_recommendations_snapshot.json");
const FRESHNESS_LIMIT_HOURS: Record<string, number> = {
  "rpp_keyword_settings.csv": 24,
  "rpp_item_settings.csv": 24,
  "rpp_exclude_items.csv": 24,
  "rpp_keyword_reports.csv": 36,
  "rpp_item_reports.csv": 36,
  "rpp_item_reports_7d.csv": 36,
  "rpp_position_adjustment_log.json": 24,
};

export function recommendationId(row: Pick<RppRecommendation, "itemCode" | "keyword" | "direction" | "currentCpc" | "meyasuCpc">) {
  return [row.itemCode, row.keyword, row.direction, row.currentCpc, row.meyasuCpc]
    .map((part) => encodeURIComponent(String(part)))
    .join("__");
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function latestRecommendationPath() {
  if (!(await pathExists(RECOMMENDATION_DIR))) return null;
  const files = await fs.readdir(RECOMMENDATION_DIR);
  const candidates = files
    .filter((name) => /^rpp_auto_recommendations_\d{8}\.json$/.test(name))
    .sort();
  return candidates.length ? path.join(RECOMMENDATION_DIR, candidates[candidates.length - 1]) : null;
}

async function readApprovals(): Promise<ApprovalFile> {
  try {
    return JSON.parse(await fs.readFile(APPROVAL_PATH, "utf8")) as ApprovalFile;
  } catch {
    return {};
  }
}

async function writeApprovals(approvals: ApprovalFile) {
  await fs.mkdir(RECOMMENDATION_DIR, { recursive: true });
  await fs.writeFile(APPROVAL_PATH, `${JSON.stringify(approvals, null, 2)}\n`, "utf8");
}

export async function readRppRecommendations() {
  const filePath = await latestRecommendationPath();
  let data: RecommendationFile | null = null;
  if (filePath) {
    data = JSON.parse(await fs.readFile(filePath, "utf8")) as RecommendationFile;
  } else {
    try {
      data = JSON.parse(await fs.readFile(SNAPSHOT_RECOMMENDATIONS_PATH, "utf8")) as RecommendationFile;
    } catch {}
  }
  if (!data) {
    return { filePath: null, summary: null, recommendations: [] as RppRecommendationWithApproval[] };
  }
  const approvals = await readApprovals();
  const recommendations = data.recommendations.map((row) => {
    const id = recommendationId(row);
    const approval = approvals[id];
    return {
      ...row,
      id,
      approvalStatus: approval?.status ?? "pending",
      approvalNote: approval?.note ?? null,
      approvedAt: approval?.updatedAt ?? null,
    } satisfies RppRecommendationWithApproval;
  });
  return { filePath, summary: data.summary, recommendations };
}

export async function updateRppApproval(id: string, status: RppApprovalStatus, note = "") {
  const allowed: RppApprovalStatus[] = ["pending", "approved", "rejected", "held"];
  if (!allowed.includes(status)) throw new Error(`Invalid status: ${status}`);
  const current = await readRppRecommendations();
  if (!current.recommendations.some((row) => row.id === id)) throw new Error(`Recommendation not found: ${id}`);
  const approvals = await readApprovals();
  approvals[id] = { status, note, updatedAt: new Date().toISOString() };
  await writeApprovals(approvals);
  return approvals[id];
}

async function statInfo(fileName: string) {
  const filePath = path.join(RPP_PROJECT_DIR, fileName);
  const maxAgeHours = FRESHNESS_LIMIT_HOURS[fileName] ?? 24;
  try {
    const st = await fs.stat(filePath);
    const ageHours = (Date.now() - st.mtime.getTime()) / 36e5;
    const ok = ageHours <= maxAgeHours;
    return { name: fileName, filePath, exists: true, ok, status: ok ? "OK" : "古い", ageHours, maxAgeHours, size: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return { name: fileName, filePath, exists: false, ok: false, status: "未取得", ageHours: null, maxAgeHours, size: 0, mtime: null };
  }
}

function reasonCounts(rows: RppRecommendationWithApproval[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const reasons = row.blocks.length ? row.blocks : row.action === "HOLD" ? ["HOLD（詳細理由なし）"] : [];
    for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, "ja"));
}

async function uploadHistory(limit = 8) {
  if (!(await pathExists(UPLOAD_DIR))) return [];
  const files = await fs.readdir(UPLOAD_DIR);
  const rows = await Promise.all(files
    .filter((name) => /^(approved|rollback)_cpc_update_\d{8}_\d{4}(?:_audit)?\.csv$/.test(name))
    .map(async (name) => {
      const filePath = path.join(UPLOAD_DIR, name);
      const st = await fs.stat(filePath);
      return {
        name,
        filePath,
        type: name.startsWith("rollback") ? "rollback" : name.includes("_audit") ? "audit" : "approved",
        size: st.size,
        mtime: st.mtime.toISOString(),
      };
    }));
  return rows.sort((a, b) => b.mtime.localeCompare(a.mtime)).slice(0, limit);
}

async function applyHistory(limit = 8) {
  try {
    const raw = JSON.parse(await fs.readFile(APPLY_LOG_PATH, "utf8")) as unknown;
    const entries = Array.isArray(raw) ? raw : (raw as { entries?: unknown[] }).entries ?? [];
    return entries
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      .sort((a, b) => String(b.loggedAt ?? "").localeCompare(String(a.loggedAt ?? "")))
      .slice(0, limit);
  } catch {
    return [] as Record<string, unknown>[];
  }
}

async function latestMorningLog() {
  try {
    const files = (await fs.readdir(RPP_LOG_DIR))
      .filter((name) => /^rpp_morning_chatwork_notify_\d{8}_\d{6}\.log$/.test(name))
      .map((name) => path.join(RPP_LOG_DIR, name));
    const stats = await Promise.all(files.map(async (filePath) => ({ filePath, st: await fs.stat(filePath) })));
    return stats.sort((a, b) => b.st.mtime.getTime() - a.st.mtime.getTime())[0] ?? null;
  } catch {
    return null;
  }
}

async function cronStatus() {
  const latest = await latestMorningLog();
  let chatworkReadback: Record<string, unknown> | null = null;
  try {
    chatworkReadback = JSON.parse(await fs.readFile(CHATWORK_LAST_READBACK_PATH, "utf8")) as Record<string, unknown>;
  } catch {}
  if (!latest) {
    return { ok: false, status: "未実行", logFile: null, mtime: null, okParts: 0, failedParts: 0, warnings: 0, chatworkReadback };
  }
  const text = await fs.readFile(latest.filePath, "utf8");
  const okParts = (text.match(/\] OK /g) ?? []).length;
  const failedParts = (text.match(/FAILED |ERROR /g) ?? []).length;
  const warnings = (text.match(/WARN /g) ?? []).length;
  const sent = text.includes("まとめて1通送信しました") || text.includes("RPP morning notify completed");
  const dryRun = text.includes("DRY RUN completed");
  return {
    ok: failedParts === 0 && sent,
    status: failedParts === 0 && sent ? "成功" : dryRun ? "ドライラン" : failedParts > 0 ? "失敗あり" : "実行中/未送信",
    logFile: latest.filePath,
    mtime: latest.st.mtime.toISOString(),
    size: latest.st.size,
    okParts,
    failedParts,
    warnings,
    sent,
    dryRun,
    chatworkReadback,
    logTail: text.split(/\r?\n/).slice(-8).join("\n"),
  };
}

export async function readRppDashboardMeta() {
  const data = await readRppRecommendations();
  const actionable = data.recommendations.filter((row) => row.action === "RAISE" || row.action === "LOWER");
  const approvedActionable = actionable.filter((row) => row.approvalStatus === "approved");
  const holdRows = data.recommendations.filter((row) => row.action === "HOLD");
  const latestFiles = await Promise.all([
    statInfo("rpp_keyword_settings.csv"),
    statInfo("rpp_item_settings.csv"),
    statInfo("rpp_exclude_items.csv"),
    statInfo("rpp_keyword_reports.csv"),
    statInfo("rpp_position_adjustment_log.json"),
  ]);

  return {
    latestFiles,
    dataReady: latestFiles.every((file) => file.ok),
    zeroCandidateReasons: actionable.length === 0 ? reasonCounts(holdRows) : [],
    holdReasonCounts: reasonCounts(holdRows),
    approvedActionableCount: approvedActionable.length,
    uploadHistory: await uploadHistory(),
    applyHistory: await applyHistory(),
    cronStatus: await cronStatus(),
  };
}
