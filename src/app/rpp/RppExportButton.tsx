"use client";

import { useState } from "react";

type ExportResult = {
  approvedCount: number;
  uploadCsv: string;
  rollbackCsv: string;
  auditCsv: string;
};

export default function RppExportButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function exportCsv() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/rpp/export-approved", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "CSV生成に失敗しました");
      setResult(data as ExportResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="export-box">
      <button className="primary-button" type="button" onClick={exportCsv} disabled={busy}>
        {busy ? "CSV生成中..." : "承認済みCSVを生成"}
      </button>
      <small>RMS反映はしません。承認済みだけ一括アップロード用CSVに出します。</small>
      {error ? <p className="error-box">{error}</p> : null}
      {result ? (
        <div className="export-result">
          <b>生成完了: {result.approvedCount}件</b><br />
          <small>アップロードCSV: {result.uploadCsv}</small><br />
          <small>ロールバックCSV: {result.rollbackCsv}</small><br />
          <small>監査CSV: {result.auditCsv}</small>
        </div>
      ) : null}
    </div>
  );
}
