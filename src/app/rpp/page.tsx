import Link from "next/link";
import { readRppDashboardMeta, readRppRecommendations } from "@/lib/rppRecommendations";
import { listRecentRppExclusionJobs } from "@/lib/rppExclusionJobs";
import { readRppAlertTargets } from "@/lib/rppTargets";
import { readRppAutoAdjustmentSettings } from "@/lib/rppAutoAdjustmentSettings";
import RppAutoAdjustmentSettingsPanel from "./RppAutoAdjustmentSettingsPanel";
import RppTargetSettings from "./RppTargetSettings";

export const dynamic = "force-dynamic";

function fmtDate(value: unknown) {
  if (!value || typeof value !== "string") return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

function shortPath(value: string) {
  return value.split("/").slice(-2).join("/");
}

function asText(value: unknown) {
  if (value == null) return "-";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function readbackLabel(row: Record<string, unknown>) {
  const applied = row.applied as { readback?: { ok?: boolean } } | undefined;
  if (!row.productionChange) return "未実行";
  if (!applied?.readback) return "未確認";
  return applied.readback.ok ? "OK" : "NG";
}

function jobStatusLabel(status: string) {
  if (status === "pending") return "待機中";
  if (status === "running") return "処理中";
  if (status === "succeeded") return "反映OK";
  if (status === "failed") return "失敗";
  return status;
}

function jobStatusClass(status: string) {
  if (status === "succeeded") return "status-approved";
  if (status === "failed") return "approval-rejected";
  return "status-hold";
}

function changeSummary(changes: { itemCode: string; currentExcluded: boolean }[]) {
  return changes.map((row) => `${row.currentExcluded ? "除外ON" : "解除"}:${row.itemCode}`).join(" / ");
}

function holdReasonCategory(row: { blocks: string[]; reasons: string[]; rppPosition: string; roas: number | null; clicks: number | null }) {
  const text = [...row.blocks, ...row.reasons, row.rppPosition].join(" / ");
  if (text.includes("データ最新性NG")) return { label: "データ古い", className: "approval-rejected", action: "順位/実績CSVを更新" };
  if (text.includes("変更不可")) return { label: "変更不可", className: "status-hold", action: "対象外のまま" };
  if (text.includes("ROAS基準未満") || (row.roas != null && row.roas < 500)) return { label: "ROAS低い", className: "approval-rejected", action: "上げずに様子見" };
  if (text.includes("RPP広告枠なし") || text.includes("広告枠なし")) return { label: "広告枠なし", className: "status-hold", action: "検索面を確認" };
  if (text.includes("順位未測定") || text.includes("未測定")) return { label: "順位未測定", className: "status-hold", action: "順位ログ更新" };
  if (text.includes("RPP順位は1ページ目内") || text.includes("PC 1位") || text.includes("SP 1位")) return { label: "上位表示済み", className: "status-approved", action: "無理に上げない" };
  if (text.includes("クリック少") || (row.clicks != null && row.clicks < 5)) return { label: "実績不足", className: "status-hold", action: "クリック蓄積待ち" };
  if (text.includes("前日レポートに該当KWなし")) return { label: "実績なし", className: "status-hold", action: "実績CSV確認" };
  if (text.includes("売上/ROASがあるため下げ慎重")) return { label: "下げ慎重", className: "status-hold", action: "手動判断" };
  return { label: "その他", className: "status-hold", action: "理由確認" };
}

function compactReasons(row: { blocks: string[]; reasons: string[] }) {
  const items = row.blocks.length ? row.blocks : row.reasons;
  return items.slice(0, 3).join(" / ") || "理由なし";
}

export default async function RppPage() {
  const data = await readRppRecommendations();
  const meta = await readRppDashboardMeta();
  const targetData = await readRppAlertTargets();
  const autoSettingsData = await readRppAutoAdjustmentSettings();
  const exclusionJobs = await listRecentRppExclusionJobs(8);
  const summary = data.summary as { generatedAt?: string; counts?: { raise?: number; lower?: number; hold?: number; ok?: number }; safety?: { productionChange?: boolean } } | null;
  const candidateTotal = (summary?.counts?.raise ?? 0) + (summary?.counts?.lower ?? 0);
  const holdRows = data.recommendations.filter((row) => row.action === "HOLD");
  const missingTargetCount = targetData.configuredTargets.filter((row) => !targetData.targets.some((target) => target.id === row.id)).length;
  const latestExclusionJob = exclusionJobs[0];

  return (
    <main className="page-shell">
      <section className="hero section-heading">
        <div>
          <p className="eyebrow">Rakuten RPP / operations</p>
          <h1>RPP広告運用候補</h1>
          <p>担当別の商品/KW一覧から、目標設定・広告除外ON/OFF・RMS反映を確認します。</p>
        </div>
        <Link className="text-link" href="/">MVPトップへ</Link>
      </section>

      <section className="grid cards">
        <div className="card"><span>上げ候補</span><strong>{summary?.counts?.raise ?? 0}</strong></div>
        <div className="card"><span>下げ候補</span><strong>{summary?.counts?.lower ?? 0}</strong></div>
        <div className="card"><span>保留</span><strong>{summary?.counts?.hold ?? 0}</strong></div>
        <div className="card"><span>RPP設定中</span><strong>{targetData.configuredTargets.length}</strong></div>
        <div className="card"><span>目標未設定</span><strong className={missingTargetCount ? "warn-text" : "ok-text"}>{missingTargetCount}</strong></div>
        <div className="card"><span>データ状態</span><strong className={meta.dataReady ? "ok-text" : "warn-text"}>{meta.dataReady ? "OK" : "要更新"}</strong></div>
      </section>

      <RppAutoAdjustmentSettingsPanel initialSettings={autoSettingsData.settings} source={autoSettingsData.source} />

      <section className="panel target-panel">
        <div className="section-heading">
          <div>
            <h2>RPPアラート目標設定</h2>
            <p>
              自動化前に、商品/KWごとのCTR・CVR・ROAS・検索位置目標を設定します。保存先 {targetData.source} / {targetData.targets.length}件
            </p>
          </div>
          <a className="text-link" href="/api/rpp/targets">Targets API</a>
        </div>
        <RppTargetSettings initialTargets={targetData.targets} configuredTargets={targetData.configuredTargets} exclusionProducts={targetData.exclusionProducts} recommendations={data.recommendations} />
      </section>

      <section className="panel history-panel compact-status-panel">
        <div className="section-heading compact-heading">
          <div>
            <h2>RMS除外アップロード状況</h2>
            <p>{latestExclusionJob ? `${fmtDate(latestExclusionJob.updatedAt)} / ${changeSummary(latestExclusionJob.changes)}` : "RMSへ反映後、ここに直近結果だけ表示します。"}</p>
          </div>
          <span className={`status-pill ${latestExclusionJob ? jobStatusClass(latestExclusionJob.status) : "status-hold"}`}>{latestExclusionJob ? jobStatusLabel(latestExclusionJob.status) : "履歴なし"}</span>
        </div>
        {latestExclusionJob?.error ? <small className="warn-text">{latestExclusionJob.error}</small> : null}
      </section>

      <details className="panel cron-panel admin-details">
        <summary>管理者用：朝cron実行結果</summary>
        <div className="section-heading compact-heading">
          <p>最終実行 {fmtDate(meta.cronStatus.mtime)} / {meta.cronStatus.logFile ? shortPath(meta.cronStatus.logFile) : "ログなし"}</p>
          <span className={`status-pill ${meta.cronStatus.ok ? "status-approved" : "approval-rejected"}`}>{meta.cronStatus.status}</span>
        </div>
        <div className="grid cards cron-cards">
          <div className="card"><span>成功パーツ</span><strong>{meta.cronStatus.okParts}</strong></div>
          <div className="card"><span>失敗</span><strong className={meta.cronStatus.failedParts ? "warn-text" : "ok-text"}>{meta.cronStatus.failedParts}</strong></div>
          <div className="card"><span>警告</span><strong>{meta.cronStatus.warnings}</strong></div>
          <div className="card"><span>Chatwork</span><strong>{meta.cronStatus.sent ? "送信済" : meta.cronStatus.dryRun ? "Dry" : "未送信"}</strong></div>
          <div className="card"><span>message_id</span><strong>{asText(meta.cronStatus.chatworkReadback?.messageId)}</strong></div>
          <div className="card"><span>読み戻し</span><strong>{meta.cronStatus.chatworkReadback ? "OK" : "未確認"}</strong></div>
        </div>
      </details>

      <section className="grid two ops-grid">
        <div className="panel">
          <h2>最新データ</h2>
          <ul className="meta-list">
            {meta.latestFiles.map((file) => (
              <li key={file.name}>
                <b>{file.name}</b>
                <small>
                  <span className={`freshness-pill freshness-${file.status}`}>{file.status}</span>
                  {file.exists ? ` ${fmtDate(file.mtime)} / ${file.size.toLocaleString("ja-JP")} bytes / ${file.ageHours?.toFixed(1)}h経過` : " 未作成"}
                </small>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <h2>{candidateTotal === 0 ? "候補0件の理由" : "保留理由"}</h2>
          {meta.zeroCandidateReasons.length || meta.holdReasonCounts.length ? (
            <ul className="meta-list">
              {(meta.zeroCandidateReasons.length ? meta.zeroCandidateReasons : meta.holdReasonCounts).slice(0, 6).map((item) => (
                <li key={item.reason}>
                  <b>{item.reason}</b>
                  <small>{item.count}件</small>
                </li>
              ))}
            </ul>
          ) : <p>ブロック理由はありません。</p>}
        </div>
      </section>

      <section className="panel history-panel hold-detail-panel">
        <div className="section-heading compact-heading">
          <div>
            <h2>保留判断メモ</h2>
            <p>保留理由を「原因」と「次アクション」に分けて表示します。RMS反映は行いません。</p>
          </div>
          <span className="status-pill status-hold">{holdRows.length}件</span>
        </div>
        {holdRows.length ? (
          <table className="wide-table hold-detail-table">
            <thead><tr><th>商品/KW</th><th>原因</th><th>CPC/順位</th><th>実績</th><th>次アクション</th></tr></thead>
            <tbody>
              {holdRows.map((row) => {
                const category = holdReasonCategory(row);
                return (
                  <tr key={row.id}>
                    <td>
                      <b>{row.itemName} {row.itemCode}</b><br />
                      <small>{row.keyword}</small>
                    </td>
                    <td>
                      <span className={`status-pill ${category.className}`}>{category.label}</span><br />
                      <small>{compactReasons(row)}</small>
                    </td>
                    <td>
                      <b>{row.currentCpc}円</b> / 目安 {row.meyasuCpc}円<br />
                      <small>{row.rppPosition}</small>
                    </td>
                    <td>
                      <small>クリック {row.clicks ?? "-"} / ROAS {row.roas == null ? "-" : `${Math.round(row.roas)}%`} / 売上 {row.salesAmount == null ? "-" : `${Math.round(row.salesAmount).toLocaleString("ja-JP")}円`}</small>
                    </td>
                    <td><b>{category.action}</b></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p>保留はありません。</p>}
      </section>

      <section className="panel history-panel">
        <h2>RMS反映ログ</h2>
        {meta.applyHistory.length ? (
          <table className="wide-table">
            <thead><tr><th>日時</th><th>結果</th><th>読戻し</th><th>件数</th><th>CSV/理由</th></tr></thead>
            <tbody>
              {meta.applyHistory.map((row, idx) => (
                <tr key={`${asText(row.loggedAt)}-${idx}`}>
                  <td>{fmtDate(row.loggedAt)}</td>
                  <td><span className={`status-pill ${row.ok ? "status-approved" : "approval-rejected"}`}>{row.ok ? (row.productionChange ? "反映" : "確認") : "停止"}</span></td>
                  <td><span className={`status-pill ${readbackLabel(row) === "OK" ? "status-approved" : readbackLabel(row) === "NG" ? "approval-rejected" : "status-hold"}`}>{readbackLabel(row)}</span></td>
                  <td>{asText(row.rowCount)}</td>
                  <td><small>{row.uploadCsv ? shortPath(asText(row.uploadCsv)) : asText(row.reason ?? row.error)}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p>反映ログはまだありません。</p>}
      </section>

      <section className="panel history-panel">
        <h2>RMS反映/CSV履歴</h2>
        {meta.uploadHistory.length ? (
          <table className="wide-table">
            <thead><tr><th>日時</th><th>種別</th><th>ファイル</th><th>サイズ</th></tr></thead>
            <tbody>
              {meta.uploadHistory.map((row) => (
                <tr key={row.filePath}>
                  <td>{fmtDate(row.mtime)}</td>
                  <td><span className={`status-pill status-${row.type}`}>{row.type}</span></td>
                  <td><small>{row.name}</small></td>
                  <td>{row.size.toLocaleString("ja-JP")} bytes</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p>CSV履歴はまだありません。</p>}
      </section>
    </main>
  );
}
