"use client";

import { useState } from "react";

type ApplyResult = {
  rowCount: number;
  uploadCsv: string;
  skipped?: boolean;
  dryRun?: boolean;
  reason?: string;
  productionChange?: boolean;
};

export default function RppApplyButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/rpp/apply-approved", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "反映チェックに失敗しました");
      setResult(data as ApplyResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="export-box danger-zone">
      <button className="danger-button" type="button" onClick={apply} disabled={busy}>
        {busy ? "反映チェック中..." : "RMS反映チェック"}
      </button>
      <small>ダッシュボードからは本番反映しません。承認0件/ガード状態を確認します。</small>
      {error ? <p className="error-box">{error}</p> : null}
      {result ? (
        <div className="export-result">
          <b>{result.productionChange ? "本番反映あり" : "本番反映なし"}</b><br />
          <small>対象: {result.rowCount}件 / {result.reason ?? (result.dryRun ? "dry-run" : "確認済み")}</small><br />
          <small>CSV: {result.uploadCsv}</small>
        </div>
      ) : null}
    </div>
  );
}
