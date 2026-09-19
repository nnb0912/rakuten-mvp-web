import Link from "next/link";
import { readRppDashboardMeta, readRppRecommendations } from "@/lib/rppRecommendations";
import { listRecentRppExclusionJobs } from "@/lib/rppExclusionJobs";
import { readRppAlertTargets } from "@/lib/rppTargets";
import { listRppAuditEvents } from "@/lib/rppAuditLog";
import { readRppAutoAdjustmentSettings } from "@/lib/rppAutoAdjustmentSettings";
import { readRppExperimentHistory } from "@/lib/rppExperiments";
import { readRppBudgetSettings, type RppBudgetMetrics } from "@/lib/rppBudgetSettings";
import { readRppDailySpendActuals, readRppDashboardDailyMetrics } from "@/lib/rppComparisons";
import { readRppStrategySettings } from "@/lib/rppStrategySettings";
import { readRppAnomalyComparison } from "@/lib/rppAnomalyData";
import { readRppNightPauseProducts } from "@/lib/rppNightPause";
import { isAutomaticRppOptimizationMode } from "@/lib/rppCpcModePolicy";
import { shortRppItemName } from "@/lib/rppItemShortNames";
import { readLatestRppDashboardSnapshot } from "@/lib/rppDashboardSnapshots";
import { buildRppDashboardPeriodSeries, buildRppDeliveryComposition } from "@/lib/rppDashboardCharts";
import { resolveRppRmsBudget } from "@/lib/rppRmsBudget";
import RppAutoAdjustmentSettingsPanel from "./RppAutoAdjustmentSettingsPanel";
import RppConsoleNav from "./RppConsoleNav";
import RppDashboardCharts from "./RppDashboardCharts";
import RppProposalLog from "./RppProposalLog";

import RppBudgetPanel from "./RppBudgetPanel";
import RppPeriodComparison from "./RppPeriodComparison";
import RppRemoveSettingCandidateExportButton from "./RppRemoveSettingCandidateExportButton";
import RppStrategyPanel from "./RppStrategyPanel";
import RppTargetSettings from "./RppTargetSettings";

import { RppInfoTip } from "./RppInfoTip";
export const dynamic = "force-dynamic";

const RPP_VIEWS = {
  dashboard: { label: "ダッシュボード", description: "候補件数とデータ状態を確認します。" },
  budget: { label: "予算管理", description: "予算進捗・期間比較・運用戦略を確認します。" },
  products: { label: "広告掲載商品リスト", description: "商品/KWの目標設定・除外・実験を操作します。" },
  excluded: { label: "除外中・広告ON戻し", description: "除外中商品を担当者別に確認し、広告ONへ戻します。" },

  optimization: { label: "自動調整設定", description: "自動調整の共通スイッチと安全設定を確認します。" },
  data: { label: "データ・実行履歴", description: "データ鮮度・保留理由・監査ログを確認します。" },
  guide: { label: "画面の見方", description: "担当別の確認手順と安全な操作方法を説明します。" },
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

function fmtYen(value: number | null | undefined) {
  return value == null ? "未取得" : `${Math.round(value).toLocaleString("ja-JP")}円`;
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
  const [data, meta, targetData, autoSettingsData, experimentHistory, exclusionJobs, budgetData, strategyData, dailyActuals, auditEvents, anomalyData, nightPauseData, dashboardDailyMetrics, latestDashboardSnapshot] = await Promise.all([
    readRppRecommendations(), readRppDashboardMeta(), readRppAlertTargets(), readRppAutoAdjustmentSettings(),
    readRppExperimentHistory(), listRecentRppExclusionJobs(8), readRppBudgetSettings(), readRppStrategySettings(), readRppDailySpendActuals(), listRppAuditEvents(30), readRppAnomalyComparison(), readRppNightPauseProducts(), readRppDashboardDailyMetrics(366), readLatestRppDashboardSnapshot(),
  ]);
  const summary = data.summary as { generatedAt?: string; performanceDateRange?: string | null; counts?: { raise?: number; lower?: number; hold?: number; ok?: number }; safety?: { productionChange?: boolean; autoAdjustment?: { enabled?: boolean } }; budgetMetrics?: RppBudgetMetrics } | null;
  const candidateTotal = (summary?.counts?.raise ?? 0) + (summary?.counts?.lower ?? 0);
  const holdRows = data.recommendations.filter((row) => row.action === "HOLD");
  const outOfScopeRows = holdRows.filter(isAutoAdjustmentOutOfScope);
  const decisionHoldRows = holdRows.filter((row) => !isAutoAdjustmentOutOfScope(row));
  const removeSettingCandidates = outOfScopeRows.filter((row) => outOfScopeOperation(row).label === "RPP設定解除候補");
  const searchSurfaceCandidates = outOfScopeRows.filter((row) => outOfScopeOperation(row).label === "検索面確認候補");
  const latestExclusionJob = exclusionJobs[0];
  const automaticTargets = targetData.targets.filter((row) => isAutomaticRppOptimizationMode(row.optimizationMode));
  const automaticTargetKeys = new Set(automaticTargets.map((row) => `${row.itemCode}\t${row.keyword}`));
  const automaticRecommendations = data.recommendations.filter((row) => automaticTargetKeys.has(`${row.itemCode}\t${row.keyword}`));
  const rppOnItemCodes = new Set(targetData.exclusionProducts.filter((row) => !row.excluded).map((row) => row.itemCode));
  const rppOnRecommendations = data.recommendations.filter((row) => rppOnItemCodes.has(row.itemCode));
  type AutomaticDashboardRow = {
    itemCode: string;
    recommendation: (typeof data.recommendations)[number] | null;
    target: (typeof targetData.targets)[number] | null;
    configured: (typeof targetData.configuredTargets)[number] | null;
    product: (typeof targetData.exclusionProducts)[number] | null;
    excluded: boolean;
  };
  const automaticRows = automaticTargets.map<AutomaticDashboardRow>((target) => {
    const product = targetData.exclusionProducts.find((row) => row.itemCode === target.itemCode) ?? null;
    const recommendation = automaticRecommendations.find((row) => row.itemCode === target.itemCode && row.keyword === target.keyword) ?? null;
    return {
      itemCode: target.itemCode,
      recommendation,
      target,
      configured: targetData.configuredTargets.find((row) => row.itemCode === target.itemCode && row.keyword === target.keyword) ?? null,
      product,
      excluded: product?.excluded === true,
    };
  });
  const allRppDelivery = buildRppDeliveryComposition(latestDashboardSnapshot);
  const rmsBudget = resolveRppRmsBudget(latestDashboardSnapshot?.rmsBudget);
  const currentMonthPerformance = buildRppDashboardPeriodSeries(dashboardDailyMetrics, "MONTH").at(-1) ?? null;
  const currentMonthLabel = currentMonthPerformance ? `${Number(currentMonthPerformance.date.slice(5, 7))}月` : "当月";


  return (
    <div className="rpp-console-shell">
      <aside className="rpp-console-nav" aria-label="RPPメニュー">
        <div className="rpp-console-brand"><span>R</span><div><b>RPP CONTROL</b><small>atRise operations</small></div></div>
        <RppConsoleNav activeView={view} items={Object.entries(RPP_VIEWS).map(([key, item]) => ({ key, label: item.label }))} />
        <div className="rpp-console-safe"><b>モード選択式</b><small>固定以外だけ自動調整</small></div>
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

      {view === "dashboard" ? <>
        <RppDashboardCharts daily={dashboardDailyMetrics} delivery={allRppDelivery} targetRoas={budgetData.settings.targetRoas} />
        <section className="panel history-panel compact-status-panel" id="rpp-dashboard-anomalies">
          <div className="section-heading compact-heading">
            <div><h2>異常チェック</h2><p>CPC・ROAS・広告費・データ鮮度・取得件数を前回データと比較します。</p></div>
            <span className={`status-pill ${anomalyData.anomalies.some((row) => row.severity === "CRITICAL") ? "approval-rejected" : anomalyData.anomalies.length ? "status-hold" : "status-approved"}`}>{anomalyData.anomalies.length ? `${anomalyData.anomalies.length}件` : "異常なし"}</span>
          </div>
          {!anomalyData.comparisonReady ? <p className="alert-comparison-note">前回データがないため変化率は未判定です。欠損・鮮度のみ判定します。</p> : null}
          {anomalyData.anomalies.length ? <ul className="rpp-alert-list">{anomalyData.anomalies.map((row) => <li key={row.type}><span className={`status-pill ${row.severity === "CRITICAL" ? "approval-rejected" : "status-hold"}`}>{row.label}</span><b>{row.detail}</b></li>)}</ul> : <p className="ok-text">現在、閾値を超えた異常はありません。</p>}
          <small>最終観測: {anomalyData.current?.observedAt ? fmtDate(anomalyData.current.observedAt) : "未取得"}</small>
        </section>
        <RppProposalLog rows={rppOnRecommendations} generatedAt={summary?.generatedAt} targetCount={rppOnItemCodes.size} />
        <section className="panel history-panel hold-detail-panel">
          <div className="section-heading compact-heading">
            <div>
              <h2>自動モードの商品</h2>
              <p>ROAS・検索順位・バランスを選択した設定行です。実績対象 {summary?.performanceDateRange || "未取得"}</p>
            </div>
            <Link className="text-link" href="/rpp?view=products">商品・KWを開く →</Link>
          </div>
          {automaticRows.length ? <table className="wide-table hold-detail-table">
            <thead><tr><th><RppInfoTip label="商品" /></th><th><RppInfoTip label="配信" /></th><th><RppInfoTip label="CPC" /></th><th><RppInfoTip label="実績" /></th><th><RppInfoTip label="検索順位" /></th><th><RppInfoTip label="判定" /></th></tr></thead>
            <tbody>{automaticRows.map((row) => {
              const rec = row.recommendation;
              const currentCpc = rec?.currentCpc ?? row.configured?.itemCpc ?? row.configured?.keywordCpc ?? null;
              const status = !row.product ? { label: "未確認", className: "status-hold" } : row.excluded ? { label: "除外中", className: "status-hold" } : rec?.action === "RAISE" ? { label: "上げ候補", className: "status-approved" } : rec?.action === "LOWER" ? { label: "下げ候補", className: "approval-rejected" } : { label: "維持", className: "status-hold" };
              return <tr key={`${row.itemCode}__${rec?.keyword || "status"}`}>
                <td><b>{row.itemCode} / {rec?.keyword || "商品"}</b><br /><small title={rec?.itemName || row.configured?.itemName || row.product?.itemName || undefined}>{shortRppItemName(row.itemCode, rec?.itemName || row.configured?.itemName || row.product?.itemName || "")}</small></td>
                <td><span className={`status-pill ${!row.product ? "status-hold" : row.excluded ? "approval-rejected" : "status-approved"}`}>{!row.product ? "未確認" : row.excluded ? "広告OFF" : "広告ON"}</span></td>
                <td><b>{currentCpc == null ? "-" : `${currentCpc}円`}</b><br /><small>{row.target?.optimizationMode || "目標未設定"}</small></td>
                <td><b>{fmtYen(rec?.spend)}</b><br /><small>{rec?.clicks == null ? "未取得" : `${rec.clicks} click`} / 売上 {fmtYen(rec?.salesAmount)} / ROAS {rec?.roas == null ? "未取得" : `${Math.round(rec.roas)}%`}</small></td>
                <td><small>{rec?.rppPosition || (row.excluded ? "除外中" : "未測定")}</small></td>
                <td><span className={`status-pill ${status.className}`}>{status.label}</span><br /><small>{!row.product ? "商品状態の実測待ち" : rec ? compactReasons(rec) : row.excluded ? "除外解除後に候補計算" : "実績更新待ち"}</small></td>
              </tr>;
            })}</tbody>
          </table> : <p className="warn-text">自動モードの商品はありません。商品・KW画面からモードを選択してください。</p>}
        </section>
      </> : null}

      {view === "guide" ?
      <section className="panel rpp-view-guide" id="rpp-guide">
        <div className="rpp-guide-head">
          <div><p className="eyebrow">RPP CONTROL / OPERATOR GUIDE</p><h2>このツールの使い方</h2><p>左メニューを上から順に確認し、担当商品を絞ってから設定・提案内容を判断します。</p></div>
          <span className="status-pill status-approved">提案のみが基本</span>
        </div>
        <div className="rpp-guide-video">
          <div className="rpp-guide-video-copy">
            <div><span className="rpp-guide-video-badge">5分04秒</span><b>全利用者向け 使い方マニュアル動画</b></div>
            <p>自分の担当商品の絞り込みからRMS反映確認まで、実際の画面と音声・字幕で確認できます。</p>
          </div>
          <video controls playsInline preload="metadata" aria-label="RPP CONTROL 使い方マニュアル動画">
            <source src="/rpp/manuals/rpp-control-guide-v13.mp4" type="video/mp4" />
            お使いのブラウザでは動画を再生できません。
          </video>
          <a href="/rpp/manuals/rpp-control-guide-v13.mp4" download>動画をダウンロード</a>
        </div>
        <section className="rpp-guide-written" aria-labelledby="rpp-guide-written-title">
          <div className="rpp-guide-written-intro">
            <p className="eyebrow">TEXT MANUAL</p>
            <h3 id="rpp-guide-written-title">文章で見る基本の使い方</h3>
            <p>動画を見られない場合は、次の順番で操作してください。普段の確認は担当商品だけに絞り、変更前後の値と実行結果を必ず確認します。</p>
          </div>
          <ol>
            <li><b>① 状態を確認</b><span>「ダッシュボード」でデータ更新時刻、配信状態、前日実績、ROAS、検索順位を確認します。</span></li>
            <li><b>② 担当商品を絞る</b><span>「広告掲載商品リスト」で担当タブを選び、必要に応じて商品番号・商品名・キーワードで検索します。</span></li>
            <li><b>③ 運用方法を設定</b><span>各行の「設定」から、ROAS・検索順位・バランス・CPC固定を選びます。商品CPCとキーワードCPCは別々に設定します。</span></li>
            <li><b>④ 除外・時間指定を設定</b><span>商品CPC行で広告除外、再開、毎日停止、単発ON/OFF予約を設定します。時刻はすべて日本時間（JST）です。</span></li>
            <li><b>⑤ 結果を確認</b><span>「データ・実行履歴」で成功・失敗とRMS読戻しを確認します。設定値とRMSの状態が一致して完了です。</span></li>
          </ol>
          <div className="rpp-guide-written-rules">
            <b>重要ルール</b>
            <ul>
              <li>RMSから直接ON/OFFしないでください。配信状態はこのツールを正本として操作します。</li>
              <li>設定を保存しただけではRMSは変更されません。反映予定・対象件数・変更前後を確認してから実行します。</li>
              <li>「変更予定」は未反映です。誤操作した場合はRMS反映前に「戻す」で取り消せます。</li>
              <li>エラーや「未確認」が出た場合は再実行せず、実行履歴とRMS状態を確認します。</li>
            </ul>
          </div>
        </section>
        <section className="rpp-guide-actions" aria-labelledby="rpp-guide-actions-title">
          <div className="rpp-guide-section-head">
            <p className="eyebrow">BUTTON GUIDE</p>
            <h3 id="rpp-guide-actions-title">各ボタンの使い方</h3>
            <p>「いつ押すか」「押した後に何が起きるか」を確認してから操作してください。</p>
          </div>
          <div className="rpp-guide-action-grid">
            <article><b>設定</b><p>商品・KWごとの運用モード、目標ROAS・順位、CPC上下限などを編集します。保存しても、その場でRMSのCPCは変わりません。</p></article>
            <article><b>CPC変更CSV</b><p>CPC固定の行だけに表示されます。固定額をRMSへ手動アップロードするCSVです。対象・変更前後・戻し用データを確認して使います。</p></article>
            <article><b>除外</b><p>商品CPC行で、その商品を広告OFFにする変更予定を作ります。押しただけでは未反映です。対象商品を確認してからRMSへ反映します。</p></article>
            <article><b>再開</b><p>除外中の商品を広告ONへ戻す変更予定を作ります。保存済み目標がない場合は押せません。先に「目標設定」を完了してください。</p></article>
            <article><b>時間指定</b><p>毎日停止または1回限りのON/OFFを予約します。RMSで広告ONを確認済みの商品だけ使用できます。保存時点ではRMSを変更しません。</p></article>
            <article><b>夜間停止</b><p>毎日01:30に広告OFF、06:00に広告ONへ戻す固定設定です。元から除外中の商品はONに戻しません。任意時刻は「時間指定」を使います。</p></article>
            <article><b>戻す</b><p>まだRMSへ反映していない「変更予定」を取り消します。反映済みの変更を戻すボタンではありません。</p></article>
            <article><b>RMSへ反映</b><p>変更予定を本番へ送ります。商品番号、変更方向、対象件数を確認して実行し、完了後は「データ・実行履歴」でRMS読戻しまで確認します。</p></article>
          </div>
        </section>
        <section className="rpp-guide-faq" aria-labelledby="rpp-guide-faq-title">
          <div className="rpp-guide-section-head">
            <p className="eyebrow">TROUBLESHOOTING</p>
            <h3 id="rpp-guide-faq-title">迷ったとき・困ったとき</h3>
            <p>次の回答で解決しない場合だけ、最後の「伝える内容」をまとめて連絡してください。</p>
          </div>
          <div className="rpp-guide-faq-grid">
            <article><b>ボタンが押せない</b><p>保護中、他の担当者が編集中、RMS状態が未確認、目標未設定、または実行中です。表示される理由を確認し、条件が整うまで無理に操作しません。</p></article>
            <article><b>データが「未確認」・「未取得」</b><p>安全に判断できる最新データがありません。CPC変更・除外・再開は行わず、「データ・実行履歴」で最終更新時刻と保留理由を確認します。</p></article>
            <article><b>エラーが表示された</b><p>同じ操作を連続で再実行しません。「データ・実行履歴」で成功・失敗・処理中を確認し、RMSの現在状態が分からない場合はそのまま止めます。</p></article>
            <article><b>ツールとRMSの表示が違う</b><p>RMSから直接ON/OFFせず、ツール側の実行履歴と読戻し結果を確認します。差異が残る場合は手動で直さず連絡してください。</p></article>
            <article><b>自動運用かCPC固定か迷う</b><p>ROAS・検索順位・バランスは自動調整対象です。金額を変えず維持したい行はCPC固定を選びます。商品CPCとキーワードCPCは行ごとに判断します。</p></article>
            <article><b>誰に何を伝える？</b><p>担当者または管理者へ、商品番号・画面名・表示された文言・発生時刻・実行したかった操作を共有してください。認証情報や顧客情報は送らないでください。</p></article>
          </div>
        </section>
        <ol className="rpp-guide-flow" aria-label="基本操作フロー">
          <li><b>1. 状態確認</b><span>ダッシュボードでデータ状態が「OK」か確認</span></li>
          <li><b>2. 担当で絞る</b><span>商品・KW画面で担当タブと検索を使う</span></li>
          <li><b>3. 判断する</b><span>CPC・ROAS・順位・保護状態を横1行で比較</span></li>
          <li><b>4. 反映前確認</b><span>変更前後・対象行・戻し手段を確認</span></li>
        </ol>
        <div className="rpp-guide-grid">
          <article><div><span>01</span><b>ダッシュボード</b></div><p>固定以外のモードを選択した商品を、商品CPC・KWCPC別に確認します。配信状態、前日実績、順位、現在判断を確認します。</p><Link href="/rpp?view=dashboard">この画面を開く →</Link></article>
          <article><div><span>02</span><b>予算管理</b></div><p>RMS有効予算、消化率、月末着地、着地差額、期間比較を確認します。予算額はRMSから取得し、この画面から変更しません。</p><Link href="/rpp?view=budget">この画面を開く →</Link></article>
          <article className="rpp-guide-wide"><div><span>03</span><b>広告掲載商品リスト</b></div><p>①担当タブを選ぶ → ②商品番号・商品名・KWで検索 → ③現CPC、提案CPC、ROAS、PC/SP順位、運用モード、保護、配信状態を確認します。「設定」で右側の編集画面を開きます。</p><ul><li><b>自動運用：</b>商品番号による制限はありません。ROAS／検索順位／バランスを選択すると、その設定行が自動調整対象になります。</li><li><b>CPC固定：</b>固定額を維持し、自動調整しません。「CPC変更CSV」からRMS手動アップロード用CSVを出力します。</li><li><b>基準ワード：</b>商品CPCの順位判定ワードを複数追加できます。どれか1語でもPC・SPの目標順位を満たせば達成扱いです。</li><li><b>商品CPC行：</b>CPC設定と商品単位の広告除外／再開を操作できます。</li><li><b>夜間停止：</b>ONの商品だけを01:30に広告OFF、06:00にONへ戻します。元から除外中の商品は戻しません。</li><li><b>KWCPC行：</b>キーワードCPCを設定します。広告除外は商品単位のため、KWCPC行には除外操作がありません。</li><li><b>変更予定：</b>RMS反映前のローカル状態です。「戻す」で取り消せます。</li></ul><Link href="/rpp?view=products">この画面を開く →</Link></article>
          <article><div><span>04</span><b>除外中・広告ON戻し</b></div><p>除外中商品を独立画面で開き、担当者タブだけで絞り込みます。目標設定後に広告ONへ戻します。</p><Link href="/rpp?view=excluded">この画面を開く →</Link></article>
          <article><div><span>05</span><b>自動調整設定</b></div><p>自動調整の全体ON/OFF、1回の最大変更幅、変更不可・RMS除外中商品の安全設定を確認します。ROAS・順位・CPC上下限は商品別設定を使います。</p><Link href="/rpp?view=optimization">この画面を開く →</Link></article>
          <article><div><span>06</span><b>実験履歴</b></div><p>既存の実験履歴は開始値と終了値を同じ指標で比較できます。現在の4つの通常運用モードは終了日不要で、実験履歴を新規作成しません。</p><Link href="/rpp?view=products">広告掲載商品リストを開く →</Link></article>
          <article><div><span>07</span><b>データ・実行履歴</b></div><p>同期ファイルの時刻、保留理由、対象外、監査ログ、RMS反映履歴を確認します。反映後は結果と読み戻しが一致しているか確認します。</p><Link href="/rpp?view=data">この画面を開く →</Link></article>
        </div>
        <div className="rpp-guide-safety">
          <div><b>ステータスの見方</b><p><span className="status-pill status-approved">上げ／正常</span> 条件を満たす候補　<span className="status-pill status-hold">保留</span> データ・条件待ち　<span className="status-pill approval-rejected">下げ／異常</span> 採算・鮮度を要確認</p></div>
          <div><b>本番反映前の必須確認</b><p>対象SKU/KW、変更前→変更後CPC、選択件数、予測効果、戻しCSVを確認します。RMS反映後は実行履歴と設定値の読み戻しが一致して初めて完了です。</p></div>
        </div>
      </section> : null}

      {view === "budget" ? <>
        <RppBudgetPanel initialSettings={budgetData.settings} source={budgetData.source} metrics={{ ...(summary?.budgetMetrics ?? {}), dailyActuals }} rmsBudget={rmsBudget} monthPerformance={currentMonthPerformance ? { label: currentMonthLabel, spend: currentMonthPerformance.spend, sales: currentMonthPerformance.sales, roas: currentMonthPerformance.roas } : null} />
        <RppPeriodComparison />
        <RppStrategyPanel initialSettings={strategyData.settings} source={strategyData.source} />
      </> : null}

      {view === "products" || view === "excluded" ? <section className="panel target-panel" id={view === "excluded" ? "rpp-excluded-view" : "rpp-products"}>
        <RppTargetSettings surface={view === "excluded" ? "excluded" : "targets"} initialTargets={targetData.targets} configuredTargets={targetData.configuredTargets} exclusionProducts={targetData.exclusionProducts} initialNightPauseItemCodes={nightPauseData.itemCodes} ownerNames={targetData.ownerNames} recommendations={data.recommendations} initialExperiments={experimentHistory} performanceDateRange={summary?.performanceDateRange} />
      </section> : null}


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
            <thead><tr><th><RppInfoTip label="商品/KW" /></th><th><RppInfoTip label="運用候補" /></th><th><RppInfoTip label="対象外理由" /></th><th><RppInfoTip label="CPC/順位" /></th><th><RppInfoTip label="実績" /></th></tr></thead>
            <tbody>
              {outOfScopeRows.map((row) => {
                const operation = outOfScopeOperation(row);
                return (
                  <tr key={row.id}>
                    <td>
                      <b title={row.itemName}>{shortRppItemName(row.itemCode, row.itemName)} {row.itemCode}</b><br />
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
            <thead><tr><th><RppInfoTip label="商品/KW" /></th><th><RppInfoTip label="原因" /></th><th><RppInfoTip label="CPC/順位" /></th><th><RppInfoTip label="実績" /></th><th><RppInfoTip label="次アクション" /></th></tr></thead>
            <tbody>
              {decisionHoldRows.map((row) => {
                const category = holdReasonCategory(row);
                return (
                  <tr key={row.id}>
                    <td>
                      <b title={row.itemName}>{shortRppItemName(row.itemCode, row.itemName)} {row.itemCode}</b><br />
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
        {auditEvents.length ? <div className="rpp-audit-table-wrap"><table className="wide-table"><thead><tr><th><RppInfoTip label="日時" /></th><th><RppInfoTip label="イベント" /></th><th><RppInfoTip label="対象" /></th><th><RppInfoTip label="実行者" /></th><th><RppInfoTip label="状態" /></th></tr></thead><tbody>{auditEvents.map((row) => <tr key={row.id}><td>{fmtDate(row.occurredAt)}</td><td><b>{row.eventType}</b></td><td>{row.entityId}</td><td><small>{row.actorId}</small></td><td><span className={`status-pill ${row.status === "failed" || row.status === "blocked" ? "approval-rejected" : "status-approved"}`}>{row.status}{row.productionChange ? " / 本番変更" : ""}</span></td></tr>)}</tbody></table></div> : <p>監査イベントはまだありません。</p>}
        <small>追記専用。更新・削除はDBトリガーで拒否します。</small>
      </section>

      <section className="panel history-panel">
        <h2>RMS反映ログ</h2>
        {meta.applyHistory.length ? (
          <table className="wide-table">
            <thead><tr><th><RppInfoTip label="日時" /></th><th><RppInfoTip label="結果" /></th><th><RppInfoTip label="読戻し" /></th><th><RppInfoTip label="件数" /></th><th><RppInfoTip label="CSV/理由" /></th></tr></thead>
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
            <thead><tr><th><RppInfoTip label="日時" /></th><th><RppInfoTip label="種別" /></th><th><RppInfoTip label="ファイル" /></th><th><RppInfoTip label="サイズ" /></th></tr></thead>
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
