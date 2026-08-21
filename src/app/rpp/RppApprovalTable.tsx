"use client";

import { useState } from "react";
import type { RppApprovalStatus, RppRecommendationWithApproval } from "@/lib/rppRecommendations";

type Props = {
  initialRows: RppRecommendationWithApproval[];
};

const labels: Record<RppApprovalStatus, string> = {
  pending: "未判断",
  approved: "承認",
  rejected: "却下",
  held: "保留",
};

function yen(value: number | null) {
  if (value == null) return "-";
  return `${Math.round(value).toLocaleString("ja-JP")}円`;
}

function pct(value: number | null) {
  if (value == null) return "-";
  return `${Math.round(value).toLocaleString("ja-JP")}%`;
}

export default function RppApprovalTable({ initialRows }: Props) {
  const [rows, setRows] = useState(initialRows);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(id: string, status: RppApprovalStatus) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch("/api/rpp/recommendations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "更新に失敗しました");
      setRows((current) => current.map((row) => row.id === id
        ? { ...row, approvalStatus: status, approvedAt: data.approval.updatedAt }
        : row));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {error ? <p className="error-box">{error}</p> : null}
      <table className="wide-table rpp-table">
        <thead>
          <tr>
            <th>商品/KW</th>
            <th>判定</th>
            <th>CPC</th>
            <th>実績</th>
            <th>順位</th>
            <th>ブロック理由</th>
            <th>承認</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <b>{row.itemName} {row.itemCode}</b><br />
                <small>{row.keyword}</small>
              </td>
              <td>
                <span className={`status-pill status-${row.action.toLowerCase()}`}>{row.action}</span><br />
                <small>{row.direction === "up" ? "上げ方向" : "下げ方向"}</small>
              </td>
              <td>
                <b>{row.currentCpc}円</b> → <b>{row.proposedCpc ?? "-"}{row.proposedCpc ? "円" : ""}</b><br />
                <small>目安 {row.meyasuCpc}円 / 差分 {row.delta ?? "-"}</small>
              </td>
              <td>
                <small>
                  Click {row.clicks ?? "-"}<br />
                  費用 {yen(row.spend)}<br />
                  売上 {yen(row.salesAmount)}<br />
                  ROAS {pct(row.roas)} / CVR {row.cvr ?? "-"}%
                </small>
              </td>
              <td><small>{row.rppPosition}</small></td>
              <td><small>{row.blocks.length ? row.blocks.join(" / ") : "なし"}</small></td>
              <td>
                <div className="approval-actions">
                  <span className={`approval-pill approval-${row.approvalStatus}`}>{labels[row.approvalStatus]}</span>
                  <button disabled={busyId === row.id || row.action === "HOLD"} onClick={() => setStatus(row.id, "approved")}>承認</button>
                  <button disabled={busyId === row.id} onClick={() => setStatus(row.id, "rejected")}>却下</button>
                  <button disabled={busyId === row.id} onClick={() => setStatus(row.id, "held")}>保留</button>
                </div>
                {row.action === "HOLD" ? <small>HOLDは承認不可</small> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
