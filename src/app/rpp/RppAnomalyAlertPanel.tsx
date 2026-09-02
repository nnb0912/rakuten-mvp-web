"use client";

import { useState } from "react";
import type { RppAnomaly, RppAnomalySnapshot } from "@/lib/rppAnomalyAlerts";

type Props = {
  current: RppAnomalySnapshot | null;
  previous: Omit<RppAnomalySnapshot, "observedAt" | "requiredFieldsPresent"> | null;
  anomalies: RppAnomaly[];
  currentSource: string | null;
  previousSource: string | null;
  comparisonReady: boolean;
};

const yen = (value: number | null | undefined) => value == null ? "-" : `${Math.round(value).toLocaleString("ja-JP")}円`;
const percent = (value: number | null | undefined) => value == null ? "-" : `${Math.round(value).toLocaleString("ja-JP")}%`;
const sourceLabel = (value: string | null) => value ? value.split("/").slice(-1)[0] : "なし";

export default function RppAnomalyAlertPanel(props: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState("");

  async function runDryPreview() {
    setBusy(true); setMessage(""); setPreview("");
    try {
      const response = await fetch("/api/rpp/anomaly-notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anomalies: props.anomalies, send: false }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? data.reason ?? "Dry Runに失敗しました");
      setPreview(data.preview ?? "プレビューなし");
      setMessage("Dry Run完了（Chatwork送信なし）");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return (
    <section className="panel rpp-alert-panel" id="rpp-alerts">
      <div className="section-heading compact-heading">
        <div><p className="eyebrow">RPP anomaly alert / dry run</p><h2>異常アラート</h2><p>CPC急騰・ROAS急落・広告費急増・データ欠損・鮮度・件数差を監視します。</p></div>
        <span className={`status-pill ${props.anomalies.some((row) => row.severity === "CRITICAL") ? "approval-rejected" : "status-approved"}`}>{props.anomalies.length ? `${props.anomalies.length}件` : "異常なし"}</span>
      </div>

      <div className="rpp-alert-metrics">
        <div><span>指標</span><b>最新</b><small>前回</small></div>
        <div><span>CPC</span><b>{yen(props.current?.cpc)}</b><small>{yen(props.previous?.cpc)}</small></div>
        <div><span>ROAS</span><b>{percent(props.current?.roas)}</b><small>{percent(props.previous?.roas)}</small></div>
        <div><span>広告費</span><b>{yen(props.current?.spend)}</b><small>{yen(props.previous?.spend)}</small></div>
        <div><span>件数</span><b>{props.current?.rowCount ?? 0}件</b><small>{props.previous?.rowCount ?? 0}件</small></div>
      </div>

      <div className="rpp-alert-body">
        <div>
          <h3>検知結果</h3>
          {!props.comparisonReady ? <p className="alert-comparison-note">前回データがないため変化率3項目は未判定。欠損・鮮度のみ判定します。</p> : null}
          {props.anomalies.length ? <ul className="rpp-alert-list">{props.anomalies.map((row) => <li key={row.type}><span className={`status-pill ${row.severity === "CRITICAL" ? "approval-rejected" : "status-hold"}`}>{row.label}</span><b>{row.detail}</b></li>)}</ul> : <p className="ok-text">現在、閾値を超えた異常はありません。</p>}
        </div>
        <div className="rpp-alert-actions">
          <h3>Chatwork通知プレビュー</h3>
          <p>画面からの操作はDry Run固定です。送信・RMS変更は行いません。</p>
          <button type="button" onClick={runDryPreview} disabled={busy}>{busy ? "生成中…" : "通知文面をDry Run"}</button>
          {preview ? <pre>{preview}</pre> : null}
          {message ? <p className="form-message">{message}</p> : null}
        </div>
      </div>
      <div className="rpp-alert-sources"><small>最新: {sourceLabel(props.currentSource)}</small><small>前回: {sourceLabel(props.previousSource)}</small><small>観測: {props.current?.observedAt ? new Date(props.current.observedAt).toLocaleString("ja-JP") : "なし"}</small></div>
    </section>
  );
}
