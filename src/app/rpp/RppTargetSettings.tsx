"use client";

import { useMemo, useState, type FormEvent } from "react";
import configuredTargetsSnapshot from "@/data/rpp_configured_targets.json";
import seoKeywords from "@/data/seo_keywords.json";
import type { RppRecommendationWithApproval } from "@/lib/rppRecommendations";
import type { RppAlertTarget, RppConfiguredTarget, RppExclusionProduct, RppOperationPolicy, RppPositionGoal } from "@/lib/rppTargets";

type Props = {
  initialTargets: RppAlertTarget[];
  configuredTargets: RppConfiguredTarget[];
  exclusionProducts: RppExclusionProduct[];
  recommendations: RppRecommendationWithApproval[];
};

type FormState = {
  itemCode: string;
  keyword: string;
  searchKeywords: string;
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
  searchKeywords: "",
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
    searchKeywords: (row.searchKeywords ?? []).join("\n"),
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
  const defaultSearchKeyword = row.keyword === "商品CPC" ? (row.rppPositionKeyword?.replace("（代表KW）", "") ?? "") : row.keyword;
  return { ...blank, itemCode: row.itemCode, keyword: row.keyword, searchKeywords: defaultSearchKeyword, owner: row.owner ?? "" };
}

function positionGoalLabel(goal: RppPositionGoal) {
  if (goal === "TOP_3") return "RPP広告3位以内";
  if (goal === "TOP_5") return "RPP広告5位以内";
  return "RPP広告1ページ目内";
}

function yen(value: number | null) {
  return value == null ? "-" : `${value.toLocaleString("ja-JP")}円`;
}

function yenNumber(value: number) {
  return `${Math.round(value).toLocaleString("ja-JP")}円`;
}

function metricKey(itemCode: string, keyword: string) {
  return `${itemCode.trim().toLowerCase()}__${keyword.trim()}`;
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

const SEO_KEYWORDS = seoKeywords as Record<string, string[]>;

function seoWordsForItem(itemCode: string) {
  const code = itemCode.trim();
  return SEO_KEYWORDS[code] || SEO_KEYWORDS[code.toLowerCase()] || SEO_KEYWORDS[code.toUpperCase()] || [];
}

export default function RppTargetSettings({ initialTargets, configuredTargets, exclusionProducts, recommendations }: Props) {
  const [targets, setTargets] = useState(initialTargets);
  const [form, setForm] = useState<FormState>(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [excludeFilter, setExcludeFilter] = useState<"active" | "excluded" | "all">("active");
  const [ownerFilter, setOwnerFilter] = useState("全て");
  const [exclusionOverrides, setExclusionOverrides] = useState<Record<string, boolean>>({});

  const targetMap = useMemo(() => new Map(targets.map((row) => [row.id, row])), [targets]);
  const positionSnapshotMap = useMemo(() => {
    const rows = (configuredTargetsSnapshot as { targets?: RppConfiguredTarget[] }).targets ?? [];
    return new Map(rows.map((row) => [row.id, row]));
  }, []);
  const missingCount = configuredTargets.filter((row) => !targetMap.has(row.id)).length;
  const itemTargetCompletionMap = useMemo(() => {
    const map = new Map<string, { total: number; saved: number; missing: number }>();
    for (const cfg of configuredTargets) {
      const current = map.get(cfg.itemCode) ?? { total: 0, saved: 0, missing: 0 };
      current.total += 1;
      if (targetMap.has(cfg.id)) current.saved += 1;
      else current.missing += 1;
      map.set(cfg.itemCode, current);
    }
    return map;
  }, [configuredTargets, targetMap]);
  const grouped = useMemo(() => targets.reduce<Record<string, number>>((acc, row) => {
    acc[row.owner || "担当未設定"] = (acc[row.owner || "担当未設定"] ?? 0) + 1;
    return acc;
  }, {}), [targets]);
  const recommendationMap = useMemo(() => new Map(recommendations.map((row) => [metricKey(row.itemCode, row.keyword), row])), [recommendations]);
  const ownerStats = useMemo(() => {
    const stats = new Map<string, { owner: string; configured: number; saved: number; missing: number; spend: number; clicks: number; sales: number; approved: number; pending: number; firstPage: number; outsidePage: number; unmeasured: number }>();
    const ensure = (owner: string) => {
      if (!stats.has(owner)) stats.set(owner, { owner, configured: 0, saved: 0, missing: 0, spend: 0, clicks: 0, sales: 0, approved: 0, pending: 0, firstPage: 0, outsidePage: 0, unmeasured: 0 });
      return stats.get(owner)!;
    };
    for (const cfg of configuredTargets) {
      const saved = targetMap.get(cfg.id);
      const owner = saved?.owner || cfg.owner || "担当未設定";
      const stat = ensure(owner);
      const rec = recommendationMap.get(metricKey(cfg.itemCode, cfg.keyword));
      stat.configured += 1;
      stat.saved += saved ? 1 : 0;
      stat.missing += saved ? 0 : 1;
      stat.spend += rec?.spend ?? 0;
      stat.clicks += rec?.clicks ?? 0;
      stat.sales += rec?.salesAmount ?? 0;
      stat.approved += rec?.approvalStatus === "approved" ? 1 : 0;
      stat.pending += rec?.approvalStatus === "pending" ? 1 : 0;
      const snapshot = positionSnapshotMap.get(cfg.id);
      const position = rec?.rppPosition || cfg.rppPosition || snapshot?.rppPosition;
      if (position) {
        if (position.includes("未測定")) stat.unmeasured += 1;
        else if (position.includes("いない") || position.includes("広告枠なし") || position.includes("測定エラー")) stat.outsidePage += 1;
        else stat.firstPage += 1;
      }
    }
    for (const row of targets) ensure(row.owner || "担当未設定");
    return [...stats.values()].sort((a, b) => (a.owner === "担当未設定" ? -1 : b.owner === "担当未設定" ? 1 : a.owner.localeCompare(b.owner, "ja")));
  }, [configuredTargets, recommendationMap, targetMap, targets, positionSnapshotMap]);
  const filteredConfiguredTargets = ownerFilter === "全て"
    ? configuredTargets
    : configuredTargets.filter((cfg) => (targetMap.get(cfg.id)?.owner || cfg.owner || "担当未設定") === ownerFilter);
  const visibleOwnerStats = ownerFilter === "全て" ? ownerStats : ownerStats.filter((row) => row.owner === ownerFilter);

  const exclusionRows = useMemo(() => exclusionProducts.map((row) => ({
    ...row,
    currentExcluded: exclusionOverrides[row.itemCode] ?? row.excluded,
  })), [exclusionProducts, exclusionOverrides]);
  const exclusionStateMap = useMemo(() => new Map(exclusionRows.map((row) => [row.itemCode, row])), [exclusionRows]);
  const exclusionChanged = exclusionRows.filter((row) => row.currentExcluded !== row.excluded);
  const visibleExclusionRows = exclusionRows.filter((row) => {
    if (excludeFilter === "active") return !row.currentExcluded;
    if (excludeFilter === "excluded") return row.currentExcluded;
    return true;
  });
  const searchWordOptions = useMemo(() => {
    const itemCode = form.itemCode.trim().toLowerCase();
    if (!itemCode) return [] as string[];
    const words = new Set<string>();
    for (const word of seoWordsForItem(itemCode)) words.add(word);
    for (const cfg of configuredTargets.filter((row) => row.itemCode === itemCode)) {
      if (cfg.keyword && cfg.keyword !== "商品CPC") words.add(cfg.keyword);
      const snapshot = positionSnapshotMap.get(cfg.id);
      const representative = cfg.rppPositionKeyword || snapshot?.rppPositionKeyword;
      if (representative) words.add(representative.replace("（代表KW）", ""));
      for (const pos of cfg.rppPositions || snapshot?.rppPositions || []) {
        if (pos.keyword) words.add(pos.keyword);
      }
    }
    const entered = form.searchKeywords.split(/[\n,、]+/).map((kw) => kw.trim()).filter(Boolean);
    return [...words].filter((word) => !entered.includes(word)).sort((a, b) => a.localeCompare(b, "ja"));
  }, [configuredTargets, form.itemCode, form.searchKeywords, positionSnapshotMap]);

  function selectOwnerFilter(owner: string) {
    setOwnerFilter(owner);
  }

  function patchForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function addSearchWord(word: string) {
    const clean = word.trim();
    if (!clean) return;
    setForm((current) => {
      const existing = current.searchKeywords.split(/[\n,、]+/).map((kw) => kw.trim()).filter(Boolean);
      if (existing.includes(clean)) return current;
      return { ...current, searchKeywords: [...existing, clean].join("\n") };
    });
  }

  function toggleExcluded(itemCode: string, canRelease = true) {
    setExclusionOverrides((current) => {
      const base = exclusionProducts.find((row) => row.itemCode === itemCode)?.excluded ?? false;
      const currentValue = current[itemCode] ?? base;
      const nextValue = !currentValue;
      if (!nextValue && !canRelease) {
        setError("この商品に目標が1つもありません。1つ以上目標を作成してから除外解除してください。");
        return current;
      }
      setError(null);
      return { ...current, [itemCode]: nextValue };
    });
  }

  function downloadExcludeCsv() {
    const excluded = exclusionRows.filter((row) => row.currentExcluded).map((row) => row.itemCode).sort((a, b) => a.localeCompare(b, "ja"));
    const lines = ["コントロールカラム,商品管理番号", ...excluded.map((code) => `,${csvCell(code)}`)];
    const blob = new Blob([`\uFEFF${lines.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ymd = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    a.href = url;
    a.download = `rpp_exclude_items_updated_${ymd}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setMessage(`RPP除外リストCSVを出力しました（除外 ${excluded.length}商品 / 変更 ${exclusionChanged.length}商品）`);
  }

  async function applyExclusionToRms() {
    if (!exclusionChanged.length) return;
    if (!window.confirm(`RMSへ除外ON/OFFを反映しますか？対象 ${exclusionChanged.length}商品。`)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/rpp/apply-exclusion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ execute: true, changes: exclusionChanged.map((row) => ({ itemCode: row.itemCode, currentExcluded: row.currentExcluded, originalExcluded: row.excluded })) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`${data.error ?? "RMS反映に失敗しました"}${data.csvPath ? ` / CSV: ${data.csvPath}` : ""}`);
      setMessage(`RMS反映を実行しました（${data.changes}商品 / CSV: ${data.csvPath}）`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveTarget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const payload = {
        ...form,
        searchKeywords: form.searchKeywords.split(/[\n,、]+/).map((kw) => kw.trim()).filter(Boolean),
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
        <div className="card"><span>担当タブ</span><strong>{ownerFilter}</strong></div>
      </div>

      <section className="panel owner-panel">
        <div className="section-heading">
          <div>
            <h2>担当者別タブ</h2>
            <p>担当を押すと画面遷移/スクロールせず、この場で担当別の集計カードと商品カードに切り替わります。</p>
          </div>
        </div>
        <div className="owner-tabs">
          <button className={ownerFilter === "全て" ? "owner-tab active" : "owner-tab"} type="button" onClick={() => selectOwnerFilter("全て")}>全て</button>
          {ownerStats.map((row) => (
            <button className={ownerFilter === row.owner ? "owner-tab active" : "owner-tab"} key={row.owner} type="button" onClick={() => selectOwnerFilter(row.owner)}>
              {row.owner}<small>{row.configured}件</small>
            </button>
          ))}
        </div>
        <div className={ownerFilter === "全て" ? "owner-card-grid" : "owner-card-grid owner-card-grid-single"}>
          {visibleOwnerStats.map((row) => {
            const roas = row.spend > 0 ? Math.round((row.sales / row.spend) * 100) : null;
            return (
              <button className={ownerFilter === row.owner ? "owner-card active" : "owner-card"} key={row.owner} type="button" onClick={() => selectOwnerFilter(row.owner)}>
                <div className="owner-card-head">
                  <b>{row.owner}</b>
                  <span>{row.configured}件</span>
                </div>
                <div className="owner-card-metrics">
                  <span><small>広告費</small><strong>{yenNumber(row.spend)}</strong></span>
                  <span><small>クリック</small><strong>{row.clicks.toLocaleString("ja-JP")}</strong></span>
                  <span><small>売上</small><strong>{yenNumber(row.sales)}</strong></span>
                  <span><small>ROAS</small><strong>{roas == null ? "-" : `${roas}%`}</strong></span>
                </div>
                <small>保存 {row.saved} / 未設定 {row.missing} / 承認 {row.approved} / 未判断 {row.pending}</small>
                <small>検索位置 1P内 {row.firstPage} / 1P外 {row.outsidePage} / 未測定 {row.unmeasured}</small>
              </button>
            );
          })}
        </div>
      </section>

      <section className="panel product-card-panel">
        <div className="section-heading">
          <div>
            <h2>{ownerFilter === "全て" ? "商品/KW別カード" : `${ownerFilter}の商品/KW`}</h2>
            <p>担当タブに合わせて、この一覧だけが切り替わります。</p>
          </div>
          <span className="status-pill status-hold">表示 {filteredConfiguredTargets.length}件</span>
        </div>
        <div className="product-card-grid">
          {filteredConfiguredTargets.map((cfg) => {
            const row = targetMap.get(cfg.id);
            const rec = recommendationMap.get(metricKey(cfg.itemCode, cfg.keyword));
            const snapshot = positionSnapshotMap.get(cfg.id);
            const position = rec?.rppPosition || cfg.rppPosition || snapshot?.rppPosition || "未測定";
            const positionKeyword = cfg.rppPositionKeyword || snapshot?.rppPositionKeyword;
            const positionRows = (cfg.rppPositions || snapshot?.rppPositions || (positionKeyword ? [{ keyword: positionKeyword, position }] : [])).filter((row) => row.keyword && row.position);
            const exclusionState = exclusionStateMap.get(cfg.itemCode);
            const currentExcluded = exclusionState?.currentExcluded ?? false;
            const exclusionChangedForItem = exclusionState ? currentExcluded !== exclusionState.excluded : false;
            const itemTargetCompletion = itemTargetCompletionMap.get(cfg.itemCode) ?? { total: 1, saved: row ? 1 : 0, missing: row ? 0 : 1 };
            const canReleaseExclusion = itemTargetCompletion.saved > 0;
            const roas = rec?.roas ?? (rec?.spend && rec.salesAmount != null ? Math.round((rec.salesAmount / rec.spend) * 100) : null);
            return (
              <article className="product-card" key={cfg.id}>
                <div className="product-card-head">
                  <div>
                    <b>{cfg.itemCode}</b>
                    <span className="status-pill status-hold">{cfg.source}</span>
                  </div>
                  <span className="owner-mini-pill">{row?.owner || cfg.owner || "担当未設定"}</span>
                </div>
                <h3>{cfg.keyword}</h3>
                <small>{cfg.itemName}</small>
                {!row ? <div className="target-missing-alert">目標未設定：RMSから直接広告設定された可能性があります。先にこのRPP設定KWの目標を作成してください。</div> : null}
                {itemTargetCompletion.saved === 0 ? <div className="target-missing-alert target-missing-alert-soft">商品内の目標保存 0/{itemTargetCompletion.total}件：1つ以上目標作成まで除外解除不可</div> : null}
                <div className="product-card-metrics">
                  <span><small>商品CPC</small><strong>{yen(cfg.itemCpc)}</strong></span>
                  <span><small>KW CPC</small><strong>{yen(cfg.keywordCpc)}</strong></span>
                  <span><small>広告費</small><strong>{yenNumber(rec?.spend ?? 0)}</strong></span>
                  <span><small>クリック</small><strong>{(rec?.clicks ?? 0).toLocaleString("ja-JP")}</strong></span>
                  <span><small>売上</small><strong>{yenNumber(rec?.salesAmount ?? 0)}</strong></span>
                  <span><small>ROAS</small><strong>{roas == null ? "-" : `${Math.round(roas)}%`}</strong></span>
                  <span className="metric-wide"><small>検索位置{positionKeyword ? `（${positionKeyword}）` : ""}</small><strong>{position}</strong></span>
                  {positionRows.length > 1 ? <span className="metric-wide position-list"><small>検索KW別</small><strong>{positionRows.map((row) => `${row.keyword}: ${row.position}`).join(" / ")}</strong></span> : null}
                </div>
                <div className="product-card-status">
                  {row ? <small>検索調査KW {(row.searchKeywords ?? []).join(" / ") || "未設定"}<br />CTR {row.ctrGoal}% / CVR {row.cvrGoal}% / ROAS最低 {row.roasFloor}%<br />{positionGoalLabel(row.positionGoal)} / {row.policy}</small> : <span className="status-pill approval-held">目標未設定</span>}
                </div>
                <div className="approval-actions card-actions">
                  <div className="product-exclusion-action">
                    <span className={`status-pill ${currentExcluded ? "approval-rejected" : "status-approved"}`}>{currentExcluded ? "除外ON" : "配信中"}</span>
                    {exclusionChangedForItem ? <small>CSV変更予定</small> : null}
                    <button
                      disabled={busy || (currentExcluded && !canReleaseExclusion)}
                      type="button"
                      onClick={() => toggleExcluded(cfg.itemCode, canReleaseExclusion)}
                      title={currentExcluded && !canReleaseExclusion ? "この商品に目標が1つ以上入るまで除外解除できません" : undefined}
                    >
                      {currentExcluded ? "除外解除" : "広告除外ON"}
                    </button>
                  </div>
                  <button disabled={busy} type="button" onClick={() => setForm(row ? toForm(row) : configuredToForm(cfg))}>{row ? "編集" : "目標作成"}</button>
                  {row ? <button disabled={busy} type="button" onClick={() => deleteTarget(row.id)}>削除</button> : null}
                </div>
              </article>
            );
          })}
          {!filteredConfiguredTargets.length ? <p>この担当のRPP設定中商品/KWはありません。</p> : null}
        </div>
      </section>


      <section className="panel exclusion-panel">
        <div className="section-heading">
          <div>
            <h2>RPP除外ON/OFF</h2>
            <p>申請/承認なしで切替できます。変更予定を作った後、RMSへ反映ボタンで一括アップロードします。</p>
          </div>
          <button className="primary-button compact-button" disabled={!exclusionChanged.length || busy} type="button" onClick={applyExclusionToRms}>RMSへ反映</button>
          <button className="secondary-button compact-button" disabled={!exclusionChanged.length} type="button" onClick={downloadExcludeCsv}>CSV出力</button>
        </div>
        <div className="grid cards target-summary-cards">
          <div className="card"><span>商品CPCあり</span><strong>{exclusionRows.length}</strong></div>
          <div className="card"><span>配信中</span><strong>{exclusionRows.filter((row) => !row.currentExcluded).length}</strong></div>
          <div className="card"><span>除外中</span><strong>{exclusionRows.filter((row) => row.currentExcluded).length}</strong></div>
          <div className="card"><span>変更予定</span><strong className={exclusionChanged.length ? "warn-text" : "ok-text"}>{exclusionChanged.length}</strong></div>
        </div>
        <div className="inline-links form-actions">
          <button className="secondary-button" type="button" onClick={() => setExcludeFilter("active")}>配信中</button>
          <button className="secondary-button" type="button" onClick={() => setExcludeFilter("excluded")}>除外中</button>
          <button className="secondary-button" type="button" onClick={() => setExcludeFilter("all")}>全て</button>
          <button className="secondary-button" disabled={!exclusionChanged.length} type="button" onClick={() => setExclusionOverrides({})}>変更を戻す</button>
        </div>
        <table className="wide-table target-table exclusion-table">
          <thead><tr><th>商品</th><th>CPC</th><th>現在/変更後</th><th>操作</th></tr></thead>
          <tbody>
            {visibleExclusionRows.slice(0, 120).map((row) => (
              <tr key={row.itemCode}>
                <td><b>{row.itemCode}</b><br /><small>{row.itemName}</small></td>
                <td>{yen(row.itemCpc)}</td>
                <td>
                  <span className={`status-pill ${row.currentExcluded ? "approval-rejected" : "status-approved"}`}>{row.currentExcluded ? "除外ON" : "配信中"}</span>
                  {row.currentExcluded !== row.excluded ? <small>変更あり（元: {row.excluded ? "除外ON" : "配信中"}）</small> : null}
                </td>
                <td><button className="secondary-button" type="button" onClick={() => toggleExcluded(row.itemCode, (itemTargetCompletionMap.get(row.itemCode)?.saved ?? 0) > 0)}>{row.currentExcluded ? "除外OFF" : "除外ON"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {visibleExclusionRows.length > 120 ? <p>表示は先頭120件です。CSV出力は全件を対象にします。</p> : null}
      </section>

      <div className="grid two target-grid">
        <form className="target-form" onSubmit={saveTarget}>
          <div className="form-row two-cols">
            <label>商品管理番号<input value={form.itemCode} onChange={(e) => patchForm("itemCode", e.target.value)} placeholder="r0606" required /></label>
            <label>RPP設定KW<input value={form.keyword} onChange={(e) => patchForm("keyword", e.target.value)} placeholder="まな板 / 商品CPC" required /></label>
          </div>
          <label>検索調査キーワード（複数可・改行/カンマ区切り）<textarea value={form.searchKeywords} onChange={(e) => patchForm("searchKeywords", e.target.value)} placeholder="まな板\nまな板 フチ付き\nかまぼこ型 まな板" /></label>
          <div className="search-word-picker">
            <label>検索対象ワードリスト
              <select value="" onChange={(e) => { addSearchWord(e.target.value); e.currentTarget.value = ""; }} disabled={!searchWordOptions.length}>
                <option value="">{searchWordOptions.length ? "候補から追加" : "候補なし"}</option>
                {searchWordOptions.map((word) => <option key={word} value={word}>{word}</option>)}
              </select>
            </label>
            {searchWordOptions.length ? <div className="search-word-chips">{searchWordOptions.map((word) => <button type="button" key={word} onClick={() => addSearchWord(word)}>＋ {word}</button>)}</div> : <small>この商品のSEO検索対策KW・RPP設定KW・代表KWから候補を出します。直接入力もできます。</small>}
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
            <li><b>除外ON/OFF</b><small>商品単位でCSV出力。RMS本番反映はCSV確認後に別途実行</small></li>
            <li><b>検索位置</b><small>目標に登録した検索調査KWを全て測定。「1ページ目にいるか/いないか」を最重要で判定</small></li>
            <li><b>担当別保存済み</b><small>{Object.entries(grouped).map(([owner, count]) => `${owner}:${count}`).join(" / ") || "未設定"}</small></li>
          </ul>
        </div>
      </div>

    </div>
  );
}
