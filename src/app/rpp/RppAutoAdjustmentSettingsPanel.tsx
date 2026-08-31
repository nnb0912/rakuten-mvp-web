"use client";

import { useState, type FormEvent } from "react";
import type { RppAutoAdjustmentSettings } from "@/lib/rppAutoAdjustmentSettings";

type Props = {
  initialSettings: RppAutoAdjustmentSettings;
  source: string;
};

type FormState = Omit<RppAutoAdjustmentSettings, "updatedAt">;

function toForm(settings: RppAutoAdjustmentSettings): FormState {
  return {
    enabled: settings.enabled,
    itemEnabledDefault: settings.itemEnabledDefault,
    keywordEnabledDefault: settings.keywordEnabledDefault,
    floorCpc: settings.floorCpc,
    itemCpcMax: settings.itemCpcMax,
    keywordCpcMax: settings.keywordCpcMax,
    maxRaisePerDay: settings.maxRaisePerDay,
    maxLowerPerDay: settings.maxLowerPerDay,
    roasFloor: settings.roasFloor,
    onlyRaiseWhenPageOut: settings.onlyRaiseWhenPageOut,
    excludeChangeLocked: settings.excludeChangeLocked,
    excludeRmsExcluded: settings.excludeRmsExcluded,
  };
}

function fmtDate(value: string | null) {
  if (!value) return "未保存";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

export default function RppAutoAdjustmentSettingsPanel({ initialSettings, source }: Props) {
  const [form, setForm] = useState<FormState>(toForm(initialSettings));
  const [updatedAt, setUpdatedAt] = useState(initialSettings.updatedAt);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regenResult, setRegenResult] = useState<{ productionChange?: boolean; json?: string; csv?: string; summary?: { counts?: { raise?: number; lower?: number; hold?: number; ok?: number }; activeRows?: number; skippedByAutoSettings?: number; safety?: { productionChange?: boolean } } } | null>(null);

  function patch<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/rpp/auto-adjustment-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "保存に失敗しました");
      setForm(toForm(data.settings));
      setUpdatedAt(data.settings.updatedAt);
      setMessage("自動調整ルールを保存しました。次回の候補生成から反映されます。");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function regenerateRecommendations() {
    setBusy(true);
    setMessage(null);
    setError(null);
    setRegenResult(null);
    try {
      const res = await fetch("/api/rpp/regenerate-recommendations", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "候補再生成に失敗しました");
      setRegenResult(data);
      const counts = data.summary?.counts ?? {};
      setMessage(`候補を再生成しました（上げ${counts.raise ?? 0} / 下げ${counts.lower ?? 0} / 保留${counts.hold ?? 0} / RMS反映なし）`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel auto-adjust-panel">
      <div className="section-heading compact-heading">
        <div>
          <h2>自動調整ルール</h2>
          <p>まずは候補生成だけに使います。RMS本番反映は別フラグ・承認後のみです。</p>
        </div>
        <span className={`status-pill ${form.enabled ? "status-approved" : "status-hold"}`}>{form.enabled ? "自動候補ON" : "自動候補OFF"}</span>
      </div>
      {error ? <p className="error-box">{error}</p> : null}
      {message ? <p className="success-box">{message}</p> : null}
      <form className="auto-adjust-form" onSubmit={save}>
        <div className="auto-switch-row">
          <label className="checkbox-field"><input type="checkbox" checked={form.enabled} onChange={(e) => patch("enabled", e.target.checked)} /> 自動調整候補を有効化</label>
          <label className="checkbox-field"><input type="checkbox" checked={form.itemEnabledDefault} onChange={(e) => patch("itemEnabledDefault", e.target.checked)} /> 商品CPCも候補化</label>
          <label className="checkbox-field"><input type="checkbox" checked={form.keywordEnabledDefault} onChange={(e) => patch("keywordEnabledDefault", e.target.checked)} /> キーワードCPCを候補化</label>
        </div>
        <div className="form-row six-cols auto-number-grid">
          <label>最低CPC<input type="number" min="1" value={form.floorCpc} onChange={(e) => patch("floorCpc", Number(e.target.value))} /></label>
          <label>商品CPC上限<input type="number" min="1" value={form.itemCpcMax} onChange={(e) => patch("itemCpcMax", Number(e.target.value))} /></label>
          <label>KW CPC上限<input type="number" min="1" value={form.keywordCpcMax} onChange={(e) => patch("keywordCpcMax", Number(e.target.value))} /></label>
          <label>1日最大上げ<input type="number" min="0" value={form.maxRaisePerDay} onChange={(e) => patch("maxRaisePerDay", Number(e.target.value))} /></label>
          <label>1日最大下げ<input type="number" min="0" value={form.maxLowerPerDay} onChange={(e) => patch("maxLowerPerDay", Number(e.target.value))} /></label>
          <label>ROAS最低<input type="number" min="0" step="10" value={form.roasFloor} onChange={(e) => patch("roasFloor", Number(e.target.value))} /></label>
        </div>
        <div className="auto-switch-row guard-row">
          <label className="checkbox-field"><input type="checkbox" checked={form.onlyRaiseWhenPageOut} onChange={(e) => patch("onlyRaiseWhenPageOut", e.target.checked)} /> 上げは検索位置が悪い時だけ</label>
          <label className="checkbox-field"><input type="checkbox" checked={form.excludeChangeLocked} onChange={(e) => patch("excludeChangeLocked", e.target.checked)} /> 変更不可リストは除外</label>
          <label className="checkbox-field"><input type="checkbox" checked={form.excludeRmsExcluded} onChange={(e) => patch("excludeRmsExcluded", e.target.checked)} /> RMS除外中商品は除外</label>
        </div>
        <div className="inline-links form-actions">
          <button className="primary-button" disabled={busy} type="submit">ルール保存</button>
          <button className="secondary-button" disabled={busy} type="button" onClick={regenerateRecommendations}>候補を再生成</button>
          <small>保存先 {source} / 最終保存 {fmtDate(updatedAt)}</small>
        </div>
        {regenResult ? (
          <div className="auto-regenerate-result">
            <b>再生成結果</b>
            <small>
              対象 {regenResult.summary?.activeRows ?? 0}件 / 設定でスキップ {regenResult.summary?.skippedByAutoSettings ?? 0}件 / 上げ {regenResult.summary?.counts?.raise ?? 0} / 下げ {regenResult.summary?.counts?.lower ?? 0} / 保留 {regenResult.summary?.counts?.hold ?? 0} / RMS反映 {regenResult.productionChange === false || regenResult.summary?.safety?.productionChange === false ? "なし" : "未確認"}
            </small>
            <small>JSON {regenResult.json ?? "-"}</small>
          </div>
        ) : null}
      </form>
    </section>
  );
}
