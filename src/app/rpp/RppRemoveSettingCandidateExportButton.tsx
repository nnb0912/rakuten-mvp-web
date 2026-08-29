"use client";

import { useEffect, useState } from "react";

type ExportRow = {
  itemCode: string;
  keyword: string;
  currentCpc: number;
  clicks: number | null;
  salesAmount: number | null;
  roas: number | null;
  rppPosition: string;
};

type DryRunResult = {
  ok: boolean;
  checkedAt: string;
  candidateCount: number;
  uploadLineCount: number;
  auditLineCount: number;
  productionChange?: boolean;
  errors?: string[];
};

type ExportHistoryRow = {
  createdAt: string;
  candidateCount: number;
  uploadCsv: string;
  auditCsv: string;
  productionChange?: boolean;
  rows?: ExportRow[];
  dryRun?: DryRunResult;
};

type ExportResult = ExportHistoryRow & {
  history?: string;
  historyRows?: ExportHistoryRow[];
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

function shortPath(path: string) {
  return path.split("/").slice(-2).join("/");
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function RppRemoveSettingCandidateExportButton({ disabled = false }: Props) {
  const [busy, setBusy] = useState(false);
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);
  const [history, setHistory] = useState<ExportHistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/rpp/export-remove-setting-candidates")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.history)) {
          setHistory(data.history);
          if (data.history[0]?.dryRun) setDryRunResult(data.history[0].dryRun);
        }
      })
      .catch(() => undefined);
  }, []);

  async function exportCsv() {
    if (!confirmed) {
      setError("CSV生成前に『検索面・商品状態を確認済み』へチェックしてください。");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    setDryRunResult(null);
    try {
      const res = await fetch("/api/rpp/export-remove-setting-candidates", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "設定解除候補CSV生成に失敗しました");
      setResult(data as ExportResult);
      if (Array.isArray(data.historyRows)) setHistory(data.historyRows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function validateDryRun() {
    setDryRunBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/rpp/validate-remove-setting-candidates", { method: "POST" });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error ?? "アップロード前ドライラン検証に失敗しました");
      setDryRunResult(data as DryRunResult);
      setHistory((current) => current.length ? [{ ...current[0], dryRun: data as DryRunResult }, ...current.slice(1)] : current);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDryRunBusy(false);
    }
  }

  const latestHistory = history[0];
  const canDryRun = Boolean(latestHistory || result);

  return (
    <div className="export-box out-of-scope-export-box">
      <label className="checkbox-field confirm-export-check">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy || disabled} />
        検索面・商品状態を確認済み
      </label>
      <button className="secondary-button compact-button" type="button" onClick={exportCsv} disabled={busy || disabled || !confirmed}>
        {busy ? "CSV生成中..." : "設定解除候補CSV"}
      </button>
      <button className="secondary-button compact-button" type="button" onClick={validateDryRun} disabled={dryRunBusy || disabled || !canDryRun}>
        {dryRunBusy ? "ドライラン確認中..." : "アップロード前ドライラン確認"}
      </button>
      <small>RMS反映なし。確認済みチェック後、設定解除候補だけを手動確認用CSV/監査CSVに出します。</small>
      {latestHistory ? <small className="export-history-note">最新履歴: {formatDate(latestHistory.createdAt)} / {latestHistory.candidateCount}件 / {shortPath(latestHistory.uploadCsv)}</small> : null}
      {dryRunResult ? <small className={dryRunResult.ok ? "dryrun-ok" : "dryrun-ng"}>ドライラン確認: {dryRunResult.ok ? "OK" : "NG"} / 候補{dryRunResult.candidateCount}件 / CSV{dryRunResult.uploadLineCount}行 / 監査{dryRunResult.auditLineCount}行 / RMS反映なし</small> : null}
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
      {history.length > 1 ? (
        <details className="remove-export-history">
          <summary>CSV生成履歴 {history.length}件</summary>
          <ul>
            {history.slice(0, 5).map((row) => (
              <li key={`${row.createdAt}-${row.uploadCsv}`}>
                <b>{formatDate(row.createdAt)}</b> / {row.candidateCount}件 / RMS反映なし{row.dryRun?.ok ? " / ドライランOK" : ""}<br />
                <small>{shortPath(row.uploadCsv)}</small>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
