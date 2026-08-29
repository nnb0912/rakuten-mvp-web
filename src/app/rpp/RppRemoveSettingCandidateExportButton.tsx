"use client";

import { useState } from "react";

type ExportResult = {
  candidateCount: number;
  uploadCsv: string;
  auditCsv: string;
  productionChange?: boolean;
};

type Props = {
  disabled?: boolean;
};

export default function RppRemoveSettingCandidateExportButton({ disabled = false }: Props) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function exportCsv() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/rpp/export-remove-setting-candidates", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "設定解除候補CSV生成に失敗しました");
      setResult(data as ExportResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="export-box out-of-scope-export-box">
      <button className="secondary-button compact-button" type="button" onClick={exportCsv} disabled={busy || disabled}>
        {busy ? "CSV生成中..." : "設定解除候補CSV"}
      </button>
      <small>RMS反映なし。設定解除候補だけを手動確認用CSV/監査CSVに出します。</small>
      {error ? <p className="error-box">{error}</p> : null}
      {result ? (
        <div className="export-result">
          <b>生成完了: {result.candidateCount}件 / RMS反映なし</b><br />
          <small>候補CSV: {result.uploadCsv}</small><br />
          <small>監査CSV: {result.auditCsv}</small>
        </div>
      ) : null}
    </div>
  );
}
