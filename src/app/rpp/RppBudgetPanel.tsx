"use client";

import { useMemo, useState } from "react";
import { calculateRppDailyBudgetPlan } from "@/lib/rppBudgetPlan";
import type { RppBudgetMetrics, RppBudgetSettings } from "@/lib/rppBudgetSettings";
import type { ResolvedRppRmsBudget } from "@/lib/rppRmsBudget";

import { RppInfoTip } from "./RppInfoTip";
type Props = { initialSettings: RppBudgetSettings; metrics: RppBudgetMetrics | null; source: string; rmsBudget: ResolvedRppRmsBudget };
const yen = (value: number) => `${Math.round(value).toLocaleString("ja-JP")}円`;
const stateLabel = { future: "予定", ok: "計画内", over: "超過", under: "未消化", unmeasured: "実績未同期" } as const;

export default function RppBudgetPanel({ initialSettings, metrics, source, rmsBudget }: Props) {
  const [settings, setSettings] = useState(initialSettings);
  const [draft, setDraft] = useState(initialSettings);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const spend = metrics?.spend ?? 0;
  const projection = metrics?.projectedMonthlySpend ?? 0;
  const metricsReady = typeof metrics?.projectedMonthlySpend === "number" && Number.isFinite(metrics.projectedMonthlySpend) && (metrics.days ?? 0) > 0;
  const monthlyBudget = rmsBudget.state === "READY" ? rmsBudget.observation?.effectiveBudget ?? null : null;
  const continuingBudget = rmsBudget.state === "READY" ? rmsBudget.observation?.continuingBudget ?? null : null;
  const usage = monthlyBudget == null ? null : monthlyBudget === 0 ? (projection > 0 ? Number.POSITIVE_INFINITY : 0) : projection / monthlyBudget * 100;
  const projectedVariance = monthlyBudget == null || !metricsReady ? null : monthlyBudget - projection;
  const effectiveSettings = useMemo(() => ({ ...settings, monthlyBudget: monthlyBudget ?? 0 }), [settings, monthlyBudget]);
  const plan = useMemo(() => monthlyBudget == null ? [] : calculateRppDailyBudgetPlan(effectiveSettings, metrics), [effectiveSettings, metrics, monthlyBudget]);
  const visiblePlan = plan.filter((row) => row.day <= new Date().getDate() + 7);
  const status = useMemo(() => {
    if (rmsBudget.state === "MISSING") return { label: "RMS予算未取得", tone: "hold" };
    if (rmsBudget.state === "UNKNOWN") return { label: "RMS取得失敗", tone: "hold" };
    if (rmsBudget.state === "STALE") return { label: "RMS予算期限切れ", tone: "warn" };
    if (rmsBudget.state === "FUTURE") return { label: "RMS時刻不正", tone: "danger" };
    if (!metricsReady) return { label: "実績未同期", tone: "hold" };
    if ((usage ?? 0) >= 100) return { label: "着地超過予測", tone: "danger" };
    if ((usage ?? 0) >= settings.warningPercent) return { label: "警告ライン", tone: "warn" };
    return { label: "予算内", tone: "ok" };
  }, [metricsReady, rmsBudget.state, settings.warningPercent, usage]);

  function updateWeight(index: number, value: number) {
    const dailyWeights = [...draft.dailyWeights];
    dailyWeights[index] = Number.isFinite(value) && value >= 0 ? value : 0;
    setDraft({ ...draft, dailyWeights });
  }

  async function save() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/rpp/budget-settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...draft, rmsBudgetSync: false }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "保存に失敗しました");
      setSettings(data.settings); setDraft(data.settings); setEditing(false); setMessage("配分設定を保存しました（RMS予算は変更していません）");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <section className="panel rpp-budget-panel" id="rpp-budget">
    <div className="section-heading compact-heading">
      <div><p className="eyebrow">BUDGET PACING</p><h2>予算管理</h2><p>RMSの有効予算を自動取得して着地を監視します。この画面からRMS予算は変更しません。</p></div>
      <div className="budget-head-actions"><span className={`budget-status ${status.tone}`}>{status.label}</span><button className="secondary-button compact-button" type="button" onClick={() => setEditing((value) => !value)}>{editing ? "閉じる" : "配分設定"}</button></div>
    </div>
    {editing ? <div className="budget-editor-wrap">
      <div className="budget-editor">
        <label><RppInfoTip label="警告ライン" /><input type="number" min="1" max="200" value={draft.warningPercent} onChange={(event) => setDraft({ ...draft, warningPercent: Number(event.target.value) })} /><small>%</small></label>
        <label><RppInfoTip label="目標ROAS" /><input type="number" min="0" value={draft.targetRoas} onChange={(event) => setDraft({ ...draft, targetRoas: Number(event.target.value) })} /><small>%</small></label>
        <label><RppInfoTip label="日別配分" /><select value={draft.allocationMode} onChange={(event) => setDraft({ ...draft, allocationMode: event.target.value === "MANUAL" ? "MANUAL" : "FLAT" })}><option value="FLAT">均等配分</option><option value="MANUAL">手動比率</option></select></label>
        <label className="budget-check"><input type="checkbox" checked={draft.redistributeRemaining} onChange={(event) => setDraft({ ...draft, redistributeRemaining: event.target.checked })} />実績同期後、残予算を残日へ再配分</label>
        <button className="primary-button compact-button" disabled={busy} type="button" onClick={save}>保存</button>
        <small>予算額はRMSから自動取得</small>
      </div>
      {draft.allocationMode === "MANUAL" ? <div className="budget-weight-grid" aria-label="日別配分比率">
        {draft.dailyWeights.map((value, index) => <label key={index + 1}><small>{index + 1}日</small><input type="number" min="0" step="0.1" value={value} onChange={(event) => updateWeight(index, Number(event.target.value))} /></label>)}
      </div> : null}
    </div> : null}
    {message ? <p className="budget-message">{message}</p> : null}
    <div className="budget-metric-grid">
      <span><small><RppInfoTip label="RMS有効予算" /></small><strong>{monthlyBudget == null ? "未取得" : yen(monthlyBudget)}</strong></span>
      <span><small><RppInfoTip label="7日広告費" /></small><strong>{yen(spend)}</strong></span>
      <span><small><RppInfoTip label="日平均" /></small><strong>{yen(metrics?.dailyAverage ?? 0)}</strong></span>
      <span className={status.tone === "danger" ? "metric-danger" : ""}><small><RppInfoTip label="月末着地予測" /></small><strong>{metricsReady ? yen(projection) : "-"}</strong></span>
      <span><small><RppInfoTip label="予算消化予測" /></small><strong>{usage == null || !metricsReady ? "-" : Number.isFinite(usage) ? `${Math.round(usage * 10) / 10}%` : "超過"}</strong></span>
      <span className={projectedVariance != null && projectedVariance < 0 ? "metric-danger" : ""}><small><RppInfoTip label="着地差額" /></small><strong>{projectedVariance == null ? "-" : `${projectedVariance >= 0 ? "余裕 " : "超過 "}${yen(Math.abs(projectedVariance))}`}</strong></span>
    </div>
    <div className="budget-progress"><i style={{ width: `${Math.min(100, usage ?? 0)}%` }} className={status.tone} /></div>
    <details className="budget-daily-details">
      <summary>日別計画・実績 <small>{settings.allocationMode === "FLAT" ? "均等配分" : "手動配分"}</small></summary>
      <div className="budget-daily-scroll"><table className="budget-daily-table"><thead><tr><th><RppInfoTip label="日" /></th><th><RppInfoTip label="配分" /></th><th><RppInfoTip label="日予算" /></th><th><RppInfoTip label="実績" /></th><th><RppInfoTip label="差額" /></th><th><RppInfoTip label="累計計画" /></th><th><RppInfoTip label="状態" /></th></tr></thead><tbody>
        {visiblePlan.map((row) => <tr key={row.date}><td>{row.day}日</td><td>{row.weightPercent}%</td><td>{yen(row.plannedBudget)}</td><td>{row.actualSpend == null ? "-" : yen(row.actualSpend)}</td><td>{row.variance == null ? "-" : `${row.variance > 0 ? "+" : ""}${yen(row.variance)}`}</td><td>{yen(row.cumulativePlan)}</td><td><span className={`budget-day-state ${row.state}`}>{stateLabel[row.state]}</span></td></tr>)}
      </tbody></table></div>
      {!metrics?.dailyActuals?.length ? <p className="budget-source-warning">日別実績CSVは未接続です。現在は計画のみ表示し、実績・差額を推測しません。</p> : null}
    </details>
    <div className="budget-foot"><small>対象 {metrics?.dateRange ?? "未同期"} / {metrics?.source ?? "商品別7日レポート"}</small><small>{rmsBudget.state === "READY" && rmsBudget.observation?.observedAt ? `RMS取得 ${new Date(rmsBudget.observation.observedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} / 有効${rmsBudget.observation.activeCampaignCount}件 / 継続月予算${continuingBudget == null ? "-" : yen(continuingBudget)}` : status.label} / 配分設定 {source}</small></div>
  </section>;
}
