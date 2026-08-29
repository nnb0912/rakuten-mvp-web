"use client";

import { useState } from "react";

type ExportRow = {
  itemCode: string;
  keyword: string;
  currentCpc: number;
  clicks: number | null;
  salesAmount: number | null;
  roas: number | null;
  rppPosition: string;
};

type ExportResult = {
  candidateCount: number;
  uploadCsv: string;
  auditCsv: string;
  productionChange?: boolean;
  rows?: ExportRow[];
};

type Props = {
  disabled?: boolean;
};

function yen(value: number | null) {
  return value == null ? "-" : `${Math.round(value).toLocaleString("ja-JP")}円`;
}

function pct(value: number | null) {
  return value == null ? "-" : `${Math.round(value).toLocaleString("ja-JP")}%`;
}

export default function RppRemoveSettingCandidateExportButton({ disabled = false }: Props) {
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function exportCsv() {
    if (!confirmed) {
      setError("CSV生成前に『検索面・商品状態を確認済み』へチェックしてください。");
      return;
    }
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
      <label className="checkbox-field confirm-export-check">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy || disabled} />
        検索面・商品状態を確認済み
      </label>
      <button className="secondary-button compact-button" type="button" onClick={exportCsv} disabled={busy || disabled || !confirmed}>
        {busy ? "CSV生成中..." : "設定解除候補CSV"}
      </button>
      <small>RMS反映なし。確認済みチェック後、設定解除候補だけを手動確認用CSV/監査CSVに出します。</small>
      {error ? <p className="error-box">{error}</p> : null}
      {result ? (
        <div className="export-result remove-export-preview">
          <b>生成完了: {result.candidateCount}件 / RMS反映なし</b><br />
          <small>候補CSV: {result.uploadCsv}</small><br />
          <small>監査CSV: {result.auditCsv}</small>
          {result.rows?.length ? (
            <table className="mini-preview-table">
              <thead><tr><th>操作</th><th>商品</th><th>KW</th><th>CPC/実績</th><th>順位</th></tr></thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={`${row.itemCode}-${row.keyword}`}>
                    <td><b>d</b><br /><small>削除候補</small></td>
                    <td>{row.itemCode}</td>
                    <td>{row.keyword}</td>
                    <td><small>CPC {yen(row.currentCpc)} / Click {row.clicks ?? "-"} / 売上 {yen(row.salesAmount)} / ROAS {pct(row.roas)}</small></td>
                    <td><small>{row.rppPosition}</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <small>プレビュー対象行はありません。</small>}
        </div>
      ) : null}
    </div>
  );
}
