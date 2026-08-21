"use client";

import { useMemo, useState, type FormEvent } from "react";
import type { RppAlertTarget, RppConfiguredTarget, RppOperationPolicy, RppPositionGoal } from "@/lib/rppTargets";

type Props = {
  initialTargets: RppAlertTarget[];
  configuredTargets: RppConfiguredTarget[];
};

type FormState = {
  itemCode: string;
  keyword: string;
  owner: string;
  ctrGoal: string;
  cvrGoal: string;
  roasFloor: string;
  positionGoal: RppPositionGoal;
  policy: RppOperationPolicy;
  note: string;
};

const blank: FormState = {
  itemCode: "",
  keyword: "",
  owner: "",
  ctrGoal: "5",
  cvrGoal: "5",
  roasFloor: "500",
  positionGoal: "FIRST_PAGE",
  policy: "維持",
  note: "",
};

function toForm(row: RppAlertTarget): FormState {
  return {
    itemCode: row.itemCode,
    keyword: row.keyword,
    owner: row.owner,
    ctrGoal: String(row.ctrGoal),
    cvrGoal: String(row.cvrGoal),
    roasFloor: String(row.roasFloor),
    positionGoal: row.positionGoal,
    policy: row.policy,
    note: row.note,
  };
}

function configuredToForm(row: RppConfiguredTarget): FormState {
  return { ...blank, itemCode: row.itemCode, keyword: row.keyword };
}

function positionGoalLabel(goal: RppPositionGoal) {
  if (goal === "TOP_3") return "RPP広告3位以内";
  if (goal === "TOP_5") return "RPP広告5位以内";
  return "RPP広告1ページ目内";
}

function yen(value: number | null) {
  return value == null ? "-" : `${value.toLocaleString("ja-JP")}円`;
}

export default function RppTargetSettings({ initialTargets, configuredTargets }: Props) {
  const [targets, setTargets] = useState(initialTargets);
  const [form, setForm] = useState<FormState>(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const targetMap = useMemo(() => new Map(targets.map((row) => [row.id, row])), [targets]);
  const missingCount = configuredTargets.filter((row) => !targetMap.has(row.id)).length;
  const grouped = useMemo(() => targets.reduce<Record<string, number>>((acc, row) => {
    acc[row.owner || "担当未設定"] = (acc[row.owner || "担当未設定"] ?? 0) + 1;
    return acc;
  }, {}), [targets]);

  function patchForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function saveTarget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const payload = {
        ...form,
        ctrGoal: Number(form.ctrGoal),
        cvrGoal: Number(form.cvrGoal),
        roasFloor: Number(form.roasFloor),
      };
      const res = await fetch("/api/rpp/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "保存に失敗しました");
      setTargets((current) => {
        const next = current.filter((row) => row.id !== data.target.id);
        return [...next, data.target].sort((a, b) => a.itemCode.localeCompare(b.itemCode, "ja") || a.keyword.localeCompare(b.keyword, "ja"));
      });
      setForm(blank);
      setMessage("保存しました");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function seedMissingTargets() {
    if (!window.confirm(`RPP設定中の未設定 ${missingCount}件を、初期値で一括作成しますか？`)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/rpp/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "seedMissing", ctrGoal: 5, cvrGoal: 5, roasFloor: 500, positionGoal: "FIRST_PAGE", policy: "維持" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "一括作成に失敗しました");
      const refreshed = await fetch("/api/rpp/targets").then((r) => r.json());
      setTargets(refreshed.targets ?? []);
      setMessage(`未設定 ${data.added}件を作成しました`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteTarget(id: string) {
    if (!window.confirm("この目標設定を削除しますか？")) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/rpp/targets?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "削除に失敗しました");
      setTargets((current) => current.filter((row) => row.id !== id));
      setMessage("削除しました");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="target-settings">
      {error ? <p className="error-box">{error}</p> : null}
      {message ? <p className="success-box">{message}</p> : null}
      <div className="grid cards target-summary-cards">
        <div className="card"><span>RPP設定中</span><strong>{configuredTargets.length}</strong></div>
        <div className="card"><span>目標保存済み</span><strong>{targets.length}</strong></div>
        <div className="card"><span>目標未設定</span><strong className={missingCount ? "warn-text" : "ok-text"}>{missingCount}</strong></div>
      </div>
      <div className="grid two target-grid">
        <form className="target-form" onSubmit={saveTarget}>
          <div className="form-row two-cols">
            <label>商品管理番号<input value={form.itemCode} onChange={(e) => patchForm("itemCode", e.target.value)} placeholder="r0606" required /></label>
            <label>キーワード<input value={form.keyword} onChange={(e) => patchForm("keyword", e.target.value)} placeholder="まな板 / 商品CPC" required /></label>
          </div>
          <div className="form-row two-cols">
            <label>担当<input value={form.owner} onChange={(e) => patchForm("owner", e.target.value)} placeholder="森下" /></label>
            <label>運用方針
              <select value={form.policy} onChange={(e) => patchForm("policy", e.target.value as RppOperationPolicy)}>
                <option value="攻め">攻め</option>
                <option value="維持">維持</option>
                <option value="テスト">テスト</option>
                <option value="停止候補">停止候補</option>
              </select>
            </label>
          </div>
          <div className="form-row four-cols">
            <label>CTR目標<input type="number" min="0" step="0.1" value={form.ctrGoal} onChange={(e) => patchForm("ctrGoal", e.target.value)} /></label>
            <label>CVR目標<input type="number" min="0" step="0.1" value={form.cvrGoal} onChange={(e) => patchForm("cvrGoal", e.target.value)} /></label>
            <label>ROAS最低<input type="number" min="0" step="10" value={form.roasFloor} onChange={(e) => patchForm("roasFloor", e.target.value)} /></label>
            <label>検索位置目標
              <select value={form.positionGoal} onChange={(e) => patchForm("positionGoal", e.target.value as RppPositionGoal)}>
                <option value="FIRST_PAGE">RPP広告1ページ目内</option>
                <option value="TOP_5">RPP広告5位以内</option>
                <option value="TOP_3">RPP広告3位以内</option>
              </select>
            </label>
          </div>
          <label>メモ<textarea value={form.note} onChange={(e) => patchForm("note", e.target.value)} placeholder="通常検索が強い場合はRPPは1ページ目内でOK、など" /></label>
          <div className="inline-links form-actions">
            <button className="primary-button" disabled={busy} type="submit">目標を保存</button>
            <button className="secondary-button" disabled={busy} type="button" onClick={() => setForm(blank)}>クリア</button>
            <button className="secondary-button" disabled={busy || missingCount === 0} type="button" onClick={seedMissingTargets}>未設定を一括作成</button>
          </div>
        </form>
        <div className="target-help">
          <h3>対象範囲</h3>
          <ul className="meta-list compact">
            <li><b>対象</b><small>自動調整候補だけでなく、RPP設定中の全商品CPC/キーワードCPC</small></li>
            <li><b>除外</b><small>RPP除外登録済み商品は対象外</small></li>
            <li><b>検索位置</b><small>「1ページ目にいるか/いないか」を最重要で判定</small></li>
            <li><b>担当別保存済み</b><small>{Object.entries(grouped).map(([owner, count]) => `${owner}:${count}`).join(" / ") || "未設定"}</small></li>
          </ul>
        </div>
      </div>

      <table className="wide-table target-table">
        <thead><tr><th>RPP設定中商品/KW</th><th>CPC</th><th>目標状態</th><th>担当/方針</th><th>操作</th></tr></thead>
        <tbody>
          {configuredTargets.map((cfg) => {
            const row = targetMap.get(cfg.id);
            return (
              <tr key={cfg.id}>
                <td><b>{cfg.itemCode}</b> <span className="status-pill status-hold">{cfg.source}</span><br /><small>{cfg.keyword}</small><br /><small>{cfg.itemName}</small></td>
                <td><small>商品CPC {yen(cfg.itemCpc)}<br />KW CPC {yen(cfg.keywordCpc)}</small></td>
                <td>{row ? <small>CTR {row.ctrGoal}% / CVR {row.cvrGoal}% / ROAS {row.roasFloor}%<br />{positionGoalLabel(row.positionGoal)}</small> : <span className="status-pill approval-held">未設定</span>}</td>
                <td><b>{row?.owner || "-"}</b><br /><small>{row?.policy || "-"}</small></td>
                <td>
                  <div className="approval-actions">
                    <button disabled={busy} type="button" onClick={() => setForm(row ? toForm(row) : configuredToForm(cfg))}>{row ? "編集" : "作成"}</button>
                    {row ? <button disabled={busy} type="button" onClick={() => deleteTarget(row.id)}>削除</button> : null}
                  </div>
                </td>
              </tr>
            );
          })}
          {!configuredTargets.length ? <tr><td colSpan={5}>RPP設定中の商品/KWが見つかりません。</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
