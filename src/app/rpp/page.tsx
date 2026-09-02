import Link from "next/link";
import { readRppDashboardMeta, readRppRecommendations } from "@/lib/rppRecommendations";
import { listRecentRppExclusionJobs } from "@/lib/rppExclusionJobs";
import { readRppAlertTargets } from "@/lib/rppTargets";
import { listRppAuditEvents } from "@/lib/rppAuditLog";
import { readRppAutoAdjustmentSettings } from "@/lib/rppAutoAdjustmentSettings";
import { readRppExperimentHistory } from "@/lib/rppExperiments";
import { readRppBudgetSettings, type RppBudgetMetrics } from "@/lib/rppBudgetSettings";
import { readRppDailySpendActuals } from "@/lib/rppComparisons";
import { readRppStrategySettings } from "@/lib/rppStrategySettings";
import { readRppAnomalyComparison } from "@/lib/rppAnomalyData";
import RppAutoAdjustmentSettingsPanel from "./RppAutoAdjustmentSettingsPanel";
import RppAnomalyAlertPanel from "./RppAnomalyAlertPanel";
import RppBudgetPanel from "./RppBudgetPanel";
import RppPeriodComparison from "./RppPeriodComparison";
import RppRemoveSettingCandidateExportButton from "./RppRemoveSettingCandidateExportButton";
import RppStrategyPanel from "./RppStrategyPanel";
import RppTargetSettings from "./RppTargetSettings";

export const dynamic = "force-dynamic";

const RPP_VIEWS = {
  dashboard: { label: "ダッシュボード", description: "候補件数とデータ状態を確認します。" },
  guide: { label: "画面の見方", description: "担当別の確認手順と安全な操作方法を説明します。" },
  budget: { label: "予算管理", description: "予算進捗・期間比較・運用戦略を確認します。" },
  products: { label: "商品・KW・実験", description: "商品/KWの目標設定・除外・実験を操作します。" },
  alerts: { label: "異常アラート", description: "CPC・ROAS・広告費・データ異常を確認します。" },
  optimization: { label: "CPC最適化", description: "自動調整ルールと安全設定を確認します。" },
  data: { label: "データ・実行履歴", description: "データ鮮度・保留理由・監査ログを確認します。" },
} as const;

type RppView = keyof typeof RPP_VIEWS;

function isRppView(value: string | string[] | undefined): value is RppView {
  return typeof value === "string" && value in RPP_VIEWS;
}

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

function isAutoAdjustmentOutOfScope(row: { blocks: string[]; reasons: string[]; rppPosition: string }) {
  const text = [...row.blocks, ...row.reasons, row.rppPosition].join(" / ");
  return text.includes("RPP広告枠なし") || text.includes("広告枠なし") || text.includes("前日レポートに該当KWなし");
}

function outOfScopeReason(row: { blocks: string[]; reasons: string[]; rppPosition: string }) {
  const text = [...row.blocks, ...row.reasons, row.rppPosition].join(" / ");
  const reasons: string[] = [];
  if (text.includes("RPP広告枠なし") || text.includes("広告枠なし")) reasons.push("広告枠なし");
  if (text.includes("前日レポートに該当KWなし")) reasons.push("前日実績なし");
  return reasons.join(" / ") || "対象外";
}

function outOfScopeOperation(row: { blocks: string[]; reasons: string[]; rppPosition: string; roas: number | null; clicks: number | null; salesAmount: number | null }) {
  const text = [...row.blocks, ...row.reasons, row.rppPosition].join(" / ");
  const noRppSlot = text.includes("RPP広告枠なし") || text.includes("広告枠なし");
  const noPerf = text.includes("前日レポートに該当KWなし") || row.clicks == null;
  const noSalesWithClicks = row.clicks != null && row.clicks >= 5 && (row.salesAmount ?? 0) <= 0 && (row.roas ?? 0) <= 0;
  if (noRppSlot && noSalesWithClicks) return { label: "RPP設定解除候補", className: "approval-rejected", note: "広告枠なし＋クリックあり売上0。RMS反映前に人が確認。" };
  if (noRppSlot && noPerf) return { label: "検索面確認候補", className: "status-hold", note: "広告枠なし＋前日実績なし。検索面/商品状態を確認。" };
  if (noRppSlot) return { label: "検索面確認候補", className: "status-hold", note: "広告枠なし。RPP面の表示有無を確認。" };
  if (noPerf) return { label: "実績確認候補", className: "status-hold", note: "前日実績なし。CSV/配信状態を確認。" };
  return { label: "確認候補", className: "status-hold", note: "人が確認。" };
}

export default async function RppPage({ searchParams }: { searchParams: Promise<{ view?: string | string[] }> }) {
  const requestedView = (await searchParams).view;
  const view: RppView = isRppView(requestedView) ? requestedView : "dashboard";
  const [data, meta, targetData, autoSettingsData, experimentHistory, exclusionJobs, budgetData, strategyData, dailyActuals, auditEvents, anomalyData] = await Promise.all([
    readRppRecommendations(), readRppDashboardMeta(), readRppAlertTargets(), readRppAutoAdjustmentSettings(),
    readRppExperimentHistory(), listRecentRppExclusionJobs(8), readRppBudgetSettings(), readRppStrategySettings(), readRppDailySpendActuals(), listRppAuditEvents(30), readRppAnomalyComparison(),
  ]);
  const summary = data.summary as { generatedAt?: string; counts?: { raise?: number; lower?: number; hold?: number; ok?: number }; safety?: { productionChange?: boolean }; budgetMetrics?: RppBudgetMetrics } | null;
  const candidateTotal = (summary?.counts?.raise ?? 0) + (summary?.counts?.lower ?? 0);
  const holdRows = data.recommendations.filter((row) => row.action === "HOLD");
  const outOfScopeRows = holdRows.filter(isAutoAdjustmentOutOfScope);
  const decisionHoldRows = holdRows.filter((row) => !isAutoAdjustmentOutOfScope(row));
  const removeSettingCandidates = outOfScopeRows.filter((row) => outOfScopeOperation(row).label === "RPP設定解除候補");
  const searchSurfaceCandidates = outOfScopeRows.filter((row) => outOfScopeOperation(row).label === "検索面確認候補");
  const latestExclusionJob = exclusionJobs[0];

  return (
    <div className="rpp-console-shell">
      <aside className="rpp-console-nav" aria-label="RPPメニュー">
        <div className="rpp-console-brand"><span>R</span><div><b>RPP CONTROL</b><small>atRise operations</small></div></div>
        <nav>
          {Object.entries(RPP_VIEWS).map(([key, item]) => (
            <Link className={view === key ? "active" : ""} href={`/rpp?view=${key}`} aria-current={view === key ? "page" : undefined} key={key}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="rpp-console-safe"><b>提案のみ</b><small>RMSへ自動反映しません</small></div>
        <Link className="rpp-console-back" href="/">← 管理トップへ</Link>
      </aside>
      <main className="page-shell rpp-console-main">
      <section className="hero section-heading rpp-console-hero" id="rpp-dashboard">
        <div>
          <p className="eyebrow">Rakuten RPP / {view}</p>
          <h1>{RPP_VIEWS[view].label}</h1>
          <p>{RPP_VIEWS[view].description}</p>
        </div>
        <div className={`rpp-console-live ${meta.dataReady ? "" : "is-stale"}`}>
          <span />
          {meta.dataReady ? `最新化済 ${fmtDate(summary?.generatedAt)}` : `要更新・最終候補 ${fmtDate(summary?.generatedAt)}`}
        </div>
      </section>

      {view === "dashboard" ? <section className="grid cards rpp-kpi-strip" aria-label="RPP概要">
        <div className="card"><span>上げ候補</span><strong>{summary?.counts?.raise ?? 0}</strong></div>
        <div className="card"><span>下げ候補</span><strong>{summary?.counts?.lower ?? 0}</strong></div>
        <div className="card"><span>保留</span><strong>{decisionHoldRows.length}</strong></div>
        <div className="card"><span>対象外</span><strong>{outOfScopeRows.length}</strong></div>
        <div className="card"><span>RPP設定中</span><strong>{targetData.configuredTargets.length}</strong></div>
        <div className="card"><span>データ状態</span><strong className={meta.dataReady ? "ok-text" : "warn-text"}>{meta.dataReady ? "OK" : "要更新"}</strong></div>
      </section> : null}

      {view === "guide" ?
      <section className="panel rpp-view-guide" id="rpp-guide">
        <div className="rpp-guide-head">
          <div><p className="eyebrow">RPP CONTROL / OPERATOR GUIDE</p><h2>このツールの使い方</h2><p>左メニューを上から順に確認し、担当商品を絞ってから設定・提案内容を判断します。</p></div>
          <span className="status-pill status-approved">提案のみが基本</span>
        </div>
        <ol className="rpp-guide-flow" aria-label="基本操作フロー">
          <li><b>1. 状態確認</b><span>ダッシュボードでデータ状態が「OK」か確認</span></li>
          <li><b>2. 担当で絞る</b><span>商品・KW画面で担当タブと検索を使う</span></li>
          <li><b>3. 判断する</b><span>CPC・ROAS・順位・保護状態を横1行で比較</span></li>
          <li><b>4. 反映前確認</b><span>変更前後・対象行・戻し手段を確認</span></li>
        </ol>
        <div className="rpp-guide-grid">
          <article><div><span>01</span><b>ダッシュボード</b></div><p>上げ・下げ・保留・対象外の件数とデータ状態を確認します。「要更新」の日は設定変更せず、データ更新を待ちます。</p><Link href="/rpp?view=dashboard">この画面を開く →</Link></article>
          <article><div><span>02</span><b>予算管理</b></div><p>月予算、消化率、月末着地、期間比較を確認します。現段階は監視専用で、ここからRMS予算を自動変更しません。</p><Link href="/rpp?view=budget">この画面を開く →</Link></article>
          <article className="rpp-guide-wide"><div><span>03</span><b>商品・KW・実験</b></div><p>①担当タブを選ぶ → ②商品番号・商品名・KWで検索 → ③現CPC、提案CPC、ROAS、PC/SP順位、運用モード、保護、配信状態を確認します。「設定」で右側の編集画面を開きます。</p><ul><li><b>商品CPC行：</b>CPC設定と商品単位の広告除外／再開を操作できます。</li><li><b>KWCPC行：</b>キーワードCPCを設定します。広告除外は商品単位のため、KWCPC行には除外操作がありません。</li><li><b>変更予定：</b>RMS反映前のローカル状態です。誤操作は同じ行の「戻す」で取り消します。</li></ul><Link href="/rpp?view=products">この画面を開く →</Link></article>
          <article><div><span>04</span><b>異常アラート</b></div><p>CPC急騰、ROAS急落、広告費急増、データ欠損・鮮度・件数差を確認します。Chatworkは画面上ではDry Run固定です。</p><Link href="/rpp?view=alerts">この画面を開く →</Link></article>
          <article><div><span>05</span><b>CPC最適化</b></div><p>最低CPC、上限、ROAS基準、1日変更幅などの提案ルールを確認します。設定は提案生成条件であり、RMSへ即時反映するものではありません。</p><Link href="/rpp?view=optimization">この画面を開く →</Link></article>
          <article><div><span>06</span><b>実験の使い方</b></div><p>商品・KW画面の「設定」から順位目標または固定CPCと終了日を保存します。開始値と終了値を同じ指標で比較し、期限切れ後は提案を停止します。</p><Link href="/rpp?view=products">商品・KW・実験を開く →</Link></article>
          <article><div><span>07</span><b>データ・実行履歴</b></div><p>同期ファイルの時刻、保留理由、対象外、監査ログ、RMS反映履歴を確認します。反映後は結果と読み戻しが一致しているか確認します。</p><Link href="/rpp?view=data">この画面を開く →</Link></article>
        </div>
        <div className="rpp-guide-safety">
          <div><b>ステータスの見方</b><p><span className="status-pill status-approved">上げ／正常</span> 条件を満たす候補　<span className="status-pill status-hold">保留</span> データ・条件待ち　<span className="status-pill approval-rejected">下げ／異常</span> 採算・鮮度を要確認</p></div>
          <div><b>本番反映前の必須確認</b><p>対象SKU/KW、変更前→変更後CPC、選択件数、予測効果、戻しCSVを確認します。RMS反映後は実行履歴と設定値の読み戻しが一致して初めて完了です。</p></div>
        </div>
      </section> : null}

      {view === "budget" ? <>
        <RppBudgetPanel initialSettings={budgetData.settings} source={budgetData.source} metrics={{ ...(summary?.budgetMetrics ?? {}), dailyActuals }} />
        <RppPeriodComparison />
        <RppStrategyPanel initialSettings={strategyData.settings} source={strategyData.source} />
      </> : null}

      {view === "products" ? <section className="panel target-panel" id="rpp-products">
        <RppTargetSettings initialTargets={targetData.targets} configuredTargets={targetData.configuredTargets} exclusionProducts={targetData.exclusionProducts} recommendations={data.recommendations} initialExperiments={experimentHistory} />
      </section> : null}

      {view === "alerts" ? <RppAnomalyAlertPanel {...anomalyData} /> : null}

      {view === "optimization" ? <div id="rpp-optimization"><RppAutoAdjustmentSettingsPanel initialSettings={autoSettingsData.settings} source={autoSettingsData.source} /></div> : null}

      {view === "dashboard" ? <section className="panel history-panel compact-status-panel">
        <div className="section-heading compact-heading">
          <div>
            <h2>RMS除外アップロード状況</h2>
            <p>{latestExclusionJob ? `${fmtDate(latestExclusionJob.updatedAt)} / ${changeSummary(latestExclusionJob.changes)}` : "RMSへ反映後、ここに直近結果だけ表示します。"}</p>
          </div>
          <span className={`status-pill ${latestExclusionJob ? jobStatusClass(latestExclusionJob.status) : "status-hold"}`}>{latestExclusionJob ? jobStatusLabel(latestExclusionJob.status) : "履歴なし"}</span>
        </div>
        {latestExclusionJob?.error ? <small className="warn-text">{latestExclusionJob.error}</small> : null}
      </section> : null}

      {view === "data" ? <>
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

      <section className="grid two ops-grid" id="rpp-data">
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

      <section className="panel history-panel hold-detail-panel out-of-scope-panel">
        <div className="section-heading compact-heading">
          <div>
            <h2>自動調整対象外</h2>
            <p>広告枠なし・前日実績なしは、CPCを自動で上げ下げせず別枠で確認します。</p>
          </div>
          <div className="out-of-scope-summary">
            <span className="status-pill approval-rejected">設定解除候補 {removeSettingCandidates.length}件</span>
            <span className="status-pill status-hold">検索面確認 {searchSurfaceCandidates.length}件</span>
            <RppRemoveSettingCandidateExportButton disabled={!removeSettingCandidates.length} />
          </div>
        </div>
        {outOfScopeRows.length ? (
          <table className="wide-table hold-detail-table">
            <thead><tr><th>商品/KW</th><th>運用候補</th><th>対象外理由</th><th>CPC/順位</th><th>実績</th></tr></thead>
            <tbody>
              {outOfScopeRows.map((row) => {
                const operation = outOfScopeOperation(row);
                return (
                  <tr key={row.id}>
                    <td>
                      <b>{row.itemName} {row.itemCode}</b><br />
                      <small>{row.keyword}</small>
                    </td>
                    <td>
                      <span className={`status-pill ${operation.className}`}>{operation.label}</span><br />
                      <small>{operation.note}</small>
                    </td>
                    <td>
                      <span className="status-pill status-hold">{outOfScopeReason(row)}</span><br />
                      <small>{compactReasons(row)}</small>
                    </td>
                    <td>
                      <b>{row.currentCpc}円</b> / 目安 {row.meyasuCpc}円<br />
                      <small>{row.rppPosition}</small>
                    </td>
                    <td>
                      <small>クリック {row.clicks ?? "-"} / ROAS {row.roas == null ? "-" : `${Math.round(row.roas)}%`} / 売上 {row.salesAmount == null ? "-" : `${Math.round(row.salesAmount).toLocaleString("ja-JP")}円`}</small>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p>対象外はありません。</p>}
      </section>

      <section className="panel history-panel hold-detail-panel">
        <div className="section-heading compact-heading">
          <div>
            <h2>保留判断メモ</h2>
            <p>ROAS・CVR・順位条件で止まったものだけ表示します。RMS反映は行いません。</p>
          </div>
          <span className="status-pill status-hold">{decisionHoldRows.length}件</span>
        </div>
        {decisionHoldRows.length ? (
          <table className="wide-table hold-detail-table">
            <thead><tr><th>商品/KW</th><th>原因</th><th>CPC/順位</th><th>実績</th><th>次アクション</th></tr></thead>
            <tbody>
              {decisionHoldRows.map((row) => {
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
        ) : <p>判断保留はありません。</p>}
      </section>

      <section className="panel history-panel" id="rpp-audit">
        <h2>統合監査ログ</h2>
        {auditEvents.length ? <table className="wide-table"><thead><tr><th>日時</th><th>イベント</th><th>対象</th><th>実行者</th><th>状態</th></tr></thead><tbody>{auditEvents.map((row) => <tr key={row.id}><td>{fmtDate(row.occurredAt)}</td><td><b>{row.eventType}</b></td><td>{row.entityId}</td><td><small>{row.actorId}</small></td><td><span className={`status-pill ${row.status === "failed" || row.status === "blocked" ? "approval-rejected" : "status-approved"}`}>{row.status}{row.productionChange ? " / 本番変更" : ""}</span></td></tr>)}</tbody></table> : <p>監査イベントはまだありません。</p>}
        <small>追記専用。更新・削除はDBトリガーで拒否します。</small>
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
      </> : null}
      </main>
    </div>
  );
}
