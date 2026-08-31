"use client";

import { useMemo, useState } from "react";
import type { RppBudgetMetrics, RppBudgetSettings } from "@/lib/rppBudgetSettings";

type Props = { initialSettings: RppBudgetSettings; metrics: RppBudgetMetrics | null; source: string };
const yen = (value: number) => `${Math.round(value).toLocaleString("ja-JP")}円`;

export default function RppBudgetPanel({ initialSettings, metrics, source }: Props) {
  const [settings, setSettings] = useState(initialSettings);
  const [draft, setDraft] = useState(initialSettings);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const spend = metrics?.spend ?? 0;
  const projection = metrics?.projectedMonthlySpend ?? 0;
  const usage = settings.monthlyBudget > 0 ? projection / settings.monthlyBudget * 100 : null;
  const status = useMemo(() => {
    if (!settings.monthlyBudget) return { label: "予算未設定", tone: "hold" };
    if ((usage ?? 0) >= 100) return { label: "着地超過予測", tone: "danger" };
    if ((usage ?? 0) >= settings.warningPercent) return { label: "警告ライン", tone: "warn" };
    return { label: "予算内", tone: "ok" };
  }, [settings.monthlyBudget, settings.warningPercent, usage]);

  async function save() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/rpp/budget-settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "保存に失敗しました");
      setSettings(data.settings); setDraft(data.settings); setEditing(false); setMessage("予算監視設定を保存しました");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <section className="panel rpp-budget-panel" id="rpp-budget">
    <div className="section-heading compact-heading">
      <div><p className="eyebrow">BUDGET PACING</p><h2>予算管理</h2><p>7日実績から月末着地を予測します。RMS予算は変更しません。</p></div>
      <div className="budget-head-actions"><span className={`budget-status ${status.tone}`}>{status.label}</span><button className="secondary-button compact-button" type="button" onClick={() => setEditing((value) => !value)}>{editing ? "閉じる" : "予算設定"}</button></div>
    </div>
    {editing ? <div className="budget-editor">
      <label>月予算<input type="number" min="0" value={draft.monthlyBudget} onChange={(event) => setDraft({ ...draft, monthlyBudget: Number(event.target.value) })} /></label>
      <label>警告ライン<input type="number" min="1" max="200" value={draft.warningPercent} onChange={(event) => setDraft({ ...draft, warningPercent: Number(event.target.value) })} /><small>%</small></label>
      <label>目標ROAS<input type="number" min="0" value={draft.targetRoas} onChange={(event) => setDraft({ ...draft, targetRoas: Number(event.target.value) })} /><small>%</small></label>
      <button className="primary-button compact-button" disabled={busy} type="button" onClick={save}>保存</button>
      <small>RMS反映 OFF（固定）</small>
    </div> : null}
    {message ? <p className="budget-message">{message}</p> : null}
    <div className="budget-metric-grid">
      <span><small>月予算</small><strong>{settings.monthlyBudget ? yen(settings.monthlyBudget) : "未設定"}</strong></span>
      <span><small>7日広告費</small><strong>{yen(spend)}</strong></span>
      <span><small>日平均</small><strong>{yen(metrics?.dailyAverage ?? 0)}</strong></span>
      <span className={status.tone === "danger" ? "metric-danger" : ""}><small>月末着地予測</small><strong>{yen(projection)}</strong></span>
      <span><small>予算消化予測</small><strong>{usage == null ? "-" : `${Math.round(usage * 10) / 10}%`}</strong></span>
      <span><small>実績ROAS</small><strong>{metrics?.roas == null ? "-" : `${Math.round(metrics.roas)}%`}</strong></span>
    </div>
    <div className="budget-progress"><i style={{ width: `${Math.min(100, usage ?? 0)}%` }} className={status.tone} /></div>
    <div className="budget-foot"><small>対象 {metrics?.dateRange ?? "未同期"} / {metrics?.source ?? "商品別7日レポート"}</small><small>保存先 {source} / RMS予算反映なし</small></div>
  </section>;
}
