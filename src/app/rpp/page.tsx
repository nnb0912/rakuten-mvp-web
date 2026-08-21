import Link from "next/link";
import { readRppDashboardMeta, readRppRecommendations } from "@/lib/rppRecommendations";
import { readRppAlertTargets } from "@/lib/rppTargets";
import RppApprovalTable from "./RppApprovalTable";
import RppExportButton from "./RppExportButton";
import RppApplyButton from "./RppApplyButton";
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

export default async function RppPage() {
  const data = await readRppRecommendations();
  const meta = await readRppDashboardMeta();
  const targetData = await readRppAlertTargets();
  const counts = data.recommendations.reduce<Record<string, number>>((acc, row) => {
    acc[row.approvalStatus] = (acc[row.approvalStatus] ?? 0) + 1;
    return acc;
  }, {});
  const summary = data.summary as { generatedAt?: string; counts?: { raise?: number; lower?: number; hold?: number; ok?: number }; safety?: { productionChange?: boolean } } | null;
  const candidateTotal = (summary?.counts?.raise ?? 0) + (summary?.counts?.lower ?? 0);

  return (
    <main className="page-shell">
      <section className="hero section-heading">
        <div>
          <p className="eyebrow">Rakuten RPP / approval workflow</p>
          <h1>RPP広告運用候補</h1>
          <p>自動提案 → 承認 → CSV生成 → RMS反映チェックまでを確認します。RMS反映は承認済みだけ対象です。</p>
        </div>
        <Link className="text-link" href="/">MVPトップへ</Link>
      </section>

      <section className="grid cards">
        <div className="card"><span>上げ候補</span><strong>{summary?.counts?.raise ?? 0}</strong></div>
        <div className="card"><span>下げ候補</span><strong>{summary?.counts?.lower ?? 0}</strong></div>
        <div className="card"><span>保留</span><strong>{summary?.counts?.hold ?? 0}</strong></div>
        <div className="card"><span>未判断</span><strong>{counts.pending ?? 0}</strong></div>
        <div className="card"><span>承認済み</span><strong>{counts.approved ?? 0}</strong></div>
        <div className="card"><span>データ状態</span><strong className={meta.dataReady ? "ok-text" : "warn-text"}>{meta.dataReady ? "OK" : "要更新"}</strong></div>
      </section>

      <section className="panel target-panel">
        <div className="section-heading">
          <div>
            <h2>RPPアラート目標設定</h2>
            <p>
              自動化前に、商品/KWごとのCTR・CVR・ROAS・検索位置目標を設定します。source {shortPath(targetData.filePath)} / {targetData.targets.length}件
            </p>
          </div>
          <a className="text-link" href="/api/rpp/targets">Targets API</a>
        </div>
        <RppTargetSettings initialTargets={targetData.targets} configuredTargets={targetData.configuredTargets} exclusionProducts={targetData.exclusionProducts} />
      </section>

      <section className="panel cron-panel">
        <div className="section-heading">
          <div>
            <h2>朝cron実行結果</h2>
            <p>
              最終実行 {fmtDate(meta.cronStatus.mtime)} / {meta.cronStatus.logFile ? shortPath(meta.cronStatus.logFile) : "ログなし"}
            </p>
          </div>
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
      </section>

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

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>承認待ち候補</h2>
            <p>
              生成日時 {fmtDate(summary?.generatedAt)} / source {data.filePath ? shortPath(data.filePath) : "なし"} / 反映対象承認 {meta.approvedActionableCount}件
            </p>
          </div>
          <div className="inline-links">
            <RppExportButton />
            <RppApplyButton />
            <a className="text-link" href="/api/rpp/recommendations">API JSON</a>
            <a className="text-link" href="/api/rpp/meta">Meta</a>
          </div>
        </div>
        {data.recommendations.length ? (
          <RppApprovalTable initialRows={data.recommendations} />
        ) : (
          <p>候補ファイルがまだありません。`rpp_auto_recommendations.js` を実行してください。</p>
        )}
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
