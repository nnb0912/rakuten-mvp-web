"use client";

import type { RppRecommendationWithApproval } from "@/lib/rppRecommendations";
import { useMemo, useState } from "react";

type ProposalFilter = "ALL" | "RAISE" | "LOWER" | "EXCLUDE";

function isExclusionCandidate(row: RppRecommendationWithApproval) {
  const detail = [...row.blocks, ...row.reasons, row.rppPosition].join(" / ");
  return row.action === "HOLD" && (detail.includes("広告枠なし") || detail.includes("RPP設定解除"));
}

function actionOf(row: RppRecommendationWithApproval) {
  if (row.action === "RAISE") return { label: "引き上げ", className: "is-raise" };
  if (row.action === "LOWER") return { label: "引き下げ", className: "is-lower" };
  return { label: "除外候補", className: "is-exclude" };
}

function proposalReason(row: RppRecommendationWithApproval) {
  const reasons = row.blocks.length ? row.blocks : row.reasons;
  const reason = reasons.slice(0, 2).join("・");
  const roas = row.roas == null ? "" : `ROAS ${Math.round(row.roas).toLocaleString("ja-JP")}%`;
  return [roas, reason || row.note || "調整条件に一致"].filter(Boolean).join("・");
}

function timeLabel(value: string | null | undefined) {
  if (!value) return "--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
}

export default function RppProposalLog({ rows, generatedAt, targetCount }: { rows: RppRecommendationWithApproval[]; generatedAt?: string | null; targetCount: number }) {
  const [filter, setFilter] = useState<ProposalFilter>("ALL");
  const proposals = useMemo(() => rows
    .filter((row) => row.action === "RAISE" || row.action === "LOWER" || isExclusionCandidate(row))
    .filter((row) => filter === "ALL" || filter === "EXCLUDE" ? (filter === "ALL" || isExclusionCandidate(row)) : row.action === filter)
    .slice(0, 30), [rows, filter]);

  const filters: Array<{ value: ProposalFilter; label: string }> = [
    { value: "ALL", label: "全て" },
    { value: "RAISE", label: "引き上げ" },
    { value: "LOWER", label: "引き下げ" },
    { value: "EXCLUDE", label: "除外" },
  ];

  return <section className="panel rpp-proposal-log" aria-labelledby="rpp-proposal-log-title">
    <div className="rpp-proposal-log-head">
      <div><h2 id="rpp-proposal-log-title">調整提案ログ</h2><p>RPP広告ONの全商品を判定した、RMS反映前の調整候補です。<b>判定対象：広告ON {targetCount.toLocaleString("ja-JP")}商品</b></p></div>
      <div className="rpp-proposal-tabs" role="group" aria-label="調整提案の種別">
        {filters.map((item) => <button type="button" key={item.value} className={filter === item.value ? "active" : ""} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}
      </div>
    </div>
    <div className="rpp-proposal-table-wrap">
      <table className="rpp-proposal-table">
        <thead><tr><th>時刻</th><th>対象</th><th>アクション</th><th>調整前CPC</th><th>調整後CPC</th><th>理由</th></tr></thead>
        <tbody>{proposals.length ? proposals.map((row) => {
          const action = actionOf(row);
          return <tr key={row.id}>
            <td>{timeLabel(generatedAt)}</td>
            <td><b>{row.itemName || row.itemCode}</b><small>{row.itemCode}{row.keyword ? ` / ${row.keyword}` : ""}</small></td>
            <td><span className={`rpp-proposal-action ${action.className}`}>{action.label}</span></td>
            <td><b>¥{Math.round(row.currentCpc).toLocaleString("ja-JP")}</b></td>
            <td><b>{row.proposedCpc == null ? "—" : `¥${Math.round(row.proposedCpc).toLocaleString("ja-JP")}`}</b></td>
            <td><small>{proposalReason(row)}</small></td>
          </tr>;
        }) : <tr><td colSpan={6} className="rpp-proposal-empty">該当する調整候補はありません</td></tr>}</tbody>
      </table>
    </div>
    <small className="rpp-proposal-scroll-note">← → 横にスクロールすると続きの列を確認できます</small>
  </section>;
}
