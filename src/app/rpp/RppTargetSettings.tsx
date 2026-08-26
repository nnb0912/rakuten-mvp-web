"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
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
  pcPositionGoal: RppPositionGoal;
  spPositionGoal: RppPositionGoal;
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
  pcPositionGoal: "FIRST_PAGE",
  spPositionGoal: "TOP_7",
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
    pcPositionGoal: row.pcPositionGoal ?? row.positionGoal,
    spPositionGoal: row.spPositionGoal ?? row.positionGoal,
    policy: row.policy,
    note: row.note,
  };
}

function representativeKeyword(row: RppConfiguredTarget, snapshot?: RppConfiguredTarget) {
  const seoRepresentative = seoWordsForItem(row.itemCode)[0];
  if (row.keyword === "商品CPC" && seoRepresentative) return seoRepresentative;
  return (row.rppPositionKeyword || snapshot?.rppPositionKeyword || row.keyword).replace("（代表KW）", "");
}

function configuredToForm(row: RppConfiguredTarget): FormState {
  const defaultSearchKeyword = row.keyword === "商品CPC" ? representativeKeyword(row) : row.keyword;
  return { ...blank, itemCode: row.itemCode, keyword: row.keyword, searchKeywords: defaultSearchKeyword, owner: row.owner ?? "" };
}

function positionGoalLabel(goal: RppPositionGoal) {
  if (goal === "TOP_3") return "RPP広告3位以内";
  if (goal === "TOP_5") return "RPP広告5位以内";
  if (goal === "TOP_7") return "RPP広告7位以内";
  return "RPP広告1ページ目内";
}

const POSITION_GOAL_OPTIONS: { value: RppPositionGoal; label: string }[] = [
  { value: "FIRST_PAGE", label: "RPP広告1ページ目内" },
  { value: "TOP_7", label: "RPP広告7位以内" },
  { value: "TOP_5", label: "RPP広告5位以内" },
  { value: "TOP_3", label: "RPP広告3位以内" },
];
const PC_POSITION_GOAL_OPTIONS = POSITION_GOAL_OPTIONS.filter((option) => option.value !== "TOP_7");

function yen(value: number | null) {
  return value == null ? "-" : `${value.toLocaleString("ja-JP")}円`;
}

function yenNumber(value: number) {
  return `${Math.round(value).toLocaleString("ja-JP")}円`;
}

function positionParts(value: string) {
  return value.split(" / ").map((part) => {
    const clean = part.trim().replace("1ページ目にいない", "圏外").replace("PR枠あり・自社広告なし", "圏外");
    const match = clean.match(/^(PC|SP|スマホ)\s+(.+)$/);
    return match ? { device: match[1], status: match[2] } : { device: "", status: clean };
  }).filter((part) => part.status);
}

function metricKey(itemCode: string, keyword: string) {
  return `${itemCode.trim().toLowerCase()}__${keyword.trim()}`;
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function downloadTextFile(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
  const [ownerFilter, setOwnerFilter] = useState("全て");
  const [exclusionSearch, setExclusionSearch] = useState("");
  const [showExcludedProducts, setShowExcludedProducts] = useState(false);
  const [baseExclusionProducts, setBaseExclusionProducts] = useState(exclusionProducts);
  const [exclusionOverrides, setExclusionOverrides] = useState<Record<string, boolean>>({});
  const targetFormRef = useRef<HTMLFormElement | null>(null);

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
  const savedTargetCountByItemCode = useMemo(() => {
    const map = new Map<string, number>();
    for (const target of targets) map.set(target.itemCode, (map.get(target.itemCode) ?? 0) + 1);
    return map;
  }, [targets]);
  const grouped = useMemo(() => targets.reduce<Record<string, number>>((acc, row) => {
    acc[row.owner || "担当未設定"] = (acc[row.owner || "担当未設定"] ?? 0) + 1;
    return acc;
  }, {}), [targets]);
  const recommendationMap = useMemo(() => new Map(recommendations.map((row) => [metricKey(row.itemCode, row.keyword), row])), [recommendations]);
  const ownerStats = useMemo(() => {
    const stats = new Map<string, { owner: string; configured: number; saved: number; missing: number; spend: number; clicks: number; sales: number; firstPage: number; outsidePage: number; unmeasured: number }>();
    const ensure = (owner: string) => {
      if (!stats.has(owner)) stats.set(owner, { owner, configured: 0, saved: 0, missing: 0, spend: 0, clicks: 0, sales: 0, firstPage: 0, outsidePage: 0, unmeasured: 0 });
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

      const snapshot = positionSnapshotMap.get(cfg.id);
      const position = rec?.rppPosition || cfg.rppPosition || snapshot?.rppPosition;
      if (position) {
        if (position.includes("未測定")) stat.unmeasured += 1;
        else if (position.includes("いない") || position.includes("自社広告なし") || position.includes("広告枠なし") || position.includes("測定エラー")) stat.outsidePage += 1;
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

  const exclusionRows = useMemo(() => baseExclusionProducts.map((row) => ({
    ...row,
    currentExcluded: exclusionOverrides[row.itemCode] ?? row.excluded,
  })), [baseExclusionProducts, exclusionOverrides]);
  const exclusionStateMap = useMemo(() => new Map(exclusionRows.map((row) => [row.itemCode, row])), [exclusionRows]);
  const exclusionChanged = exclusionRows.filter((row) => row.currentExcluded !== row.excluded);
  const excludedProductsForOwner = exclusionRows.filter((row) => row.currentExcluded && (ownerFilter === "全て" || (row.owner || "担当未設定") === ownerFilter));
  const filteredExcludedProducts = excludedProductsForOwner.filter((row) => {
    const query = exclusionSearch.trim().toLowerCase();
    if (!query) return true;
    return [row.itemCode, row.itemName, row.owner || "担当未設定"].some((value) => value.toLowerCase().includes(query));
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

  function openTargetForm(nextForm: FormState) {
    setForm(nextForm);
    setTimeout(() => targetFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function excludedProductToForm(row: RppExclusionProduct): FormState {
    return { ...blank, itemCode: row.itemCode, keyword: "商品CPC", owner: row.owner ?? "", searchKeywords: seoWordsForItem(row.itemCode)[0] ?? "" };
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
      const base = baseExclusionProducts.find((row) => row.itemCode === itemCode)?.excluded ?? false;
      const currentValue = current[itemCode] ?? base;
      const nextValue = !currentValue;
      if (!nextValue && !canRelease && base) {
        setError("この商品に目標が1つもありません。1つ以上目標を作成してから除外解除してください。");
        return current;
      }
      setError(null);
      return { ...current, [itemCode]: nextValue };
    });
  }

  function downloadExcludeCsv() {
    const changes = exclusionChanged.map((row) => [row.currentExcluded ? "n" : "d", row.itemCode]);
    const lines = ["コントロールカラム,商品管理番号", ...changes.map((row) => row.map(csvCell).join(","))];
    downloadTextFile(`rpp_exclude_diff_${new Date().toISOString().slice(0, 10).replaceAll("-", "")}.csv`, `\uFEFF${lines.join("\r\n")}\r\n`);
    setMessage(`RMS手動アップロード用CSVを出力しました（変更 ${changes.length}商品 / n=除外登録, d=除外解除）`);
  }

  function downloadCpcCsv(cfg: RppConfiguredTarget) {
    const current = cfg.source === "商品CPC" ? cfg.itemCpc : cfg.keywordCpc;
    const input = window.prompt(`${cfg.itemCode} / ${cfg.keyword} の新しいCPCを入力してください（現在 ${yen(current)}）`, current ? String(current) : "");
    if (input == null) return;
    const nextCpc = Number(input.replace(/,/g, "").trim());
    if (!Number.isFinite(nextCpc) || nextCpc <= 0) {
      setError("CPCは1以上の数字で入力してください。");
      return;
    }
    const ymd = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const isItemCpc = cfg.source === "商品CPC";
    const header = isItemCpc ? ["コントロールカラム", "商品管理番号", "商品CPC"] : ["コントロールカラム", "商品管理番号", "キーワード", "キーワードCPC"];
    const row = isItemCpc ? ["u", cfg.itemCode, String(nextCpc)] : ["u", cfg.itemCode, cfg.keyword, String(nextCpc)];
    downloadTextFile(`rpp_cpc_update_${cfg.itemCode}_${ymd}.csv`, `\uFEFF${header.map(csvCell).join(",")}\r\n${row.map(csvCell).join(",")}\r\n`);
    setError(null);
    setMessage(`CPC調整CSVを出力しました（${cfg.itemCode} / ${cfg.keyword}: ${yen(current)} → ${nextCpc.toLocaleString("ja-JP")}円）`);
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
      if (!res.ok) {
        const detail = [data.errorOutput, data.output]
          .filter(Boolean)
          .join("\n")
          .slice(0, 600)
          .replace(/[\r\n]+/g, " / ");
        throw new Error(`${data.error ?? "RMS反映に失敗しました"}${data.csvPath ? ` / CSV: ${data.csvPath}` : ""}${detail ? ` / 詳細: ${detail}` : ""}`);
      }
      if (data.queued) {
        setExclusionOverrides({});
        setMessage(`RMS反映ジョブを登録しました（${data.changes}商品 / job: ${data.jobId}）。Mac Studioワーカーが反映・読戻し確認します。`);
      } else if (data.productionChange === false || data.disabled) {
        setMessage(`${data.reason ?? "RMS自動反映は無効です。CSVのみ生成しました。"}（${data.changes}商品 / CSV: ${data.csvPath}）`);
      } else {
        const appliedRows = exclusionChanged.map((row) => ({ itemCode: row.itemCode, currentExcluded: row.currentExcluded }));
        setBaseExclusionProducts((current) => current.map((row) => {
          const applied = appliedRows.find((item) => item.itemCode === row.itemCode);
          return applied ? { ...row, excluded: applied.currentExcluded } : row;
        }));
        setExclusionOverrides({});
        setMessage(`RMS反映を実行しました（${data.changes}商品 / CSV: ${data.csvPath}）`);
      }
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
        positionGoal: form.pcPositionGoal,
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
        body: JSON.stringify({ action: "seedMissing", ctrGoal: 5, cvrGoal: 5, roasFloor: 500, positionGoal: "FIRST_PAGE", pcPositionGoal: "FIRST_PAGE", spPositionGoal: "TOP_7", policy: "維持" }),
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
                <small>保存 {row.saved} / 未設定 {row.missing}</small>
                <small>検索位置 1P内 {row.firstPage} / 1P外 {row.outsidePage} / 未測定 {row.unmeasured}</small>
              </button>
            );
          })}
        </div>
      </section>

      <section className="panel product-card-panel">
        <div className="section-heading">
          <div>
            <h2>{ownerFilter === "全て" ? "商品/KW別一覧" : `${ownerFilter}の商品/KW`}</h2>
            <p>担当タブに合わせて、この一覧だけが切り替わります。</p>
          </div>
          <div className="product-list-actions">
            <span className="status-pill status-hold">表示 {filteredConfiguredTargets.length}件</span>
            <span className={exclusionChanged.length ? "status-pill approval-held" : "status-pill status-approved"}>変更予定 {exclusionChanged.length}件</span>
            <button className="primary-button compact-button" disabled={!exclusionChanged.length || busy} type="button" onClick={applyExclusionToRms}>RMSへ反映</button>
            <button className="secondary-button compact-button" disabled={!exclusionChanged.length} type="button" onClick={downloadExcludeCsv}>手動CSV</button>
            <button className="secondary-button compact-button" disabled={!exclusionChanged.length} type="button" onClick={() => setExclusionOverrides({})}>変更を戻す</button>
            <small className="rms-upload-note">自動反映がRMSログインエラーになる場合は、手動CSVをRMS除外商品の一括アップロードへ入れてください。</small>
          </div>
        </div>
        <div className="product-card-grid">
          {filteredConfiguredTargets.map((cfg) => {
            const row = targetMap.get(cfg.id);
            const rec = recommendationMap.get(metricKey(cfg.itemCode, cfg.keyword));
            const snapshot = positionSnapshotMap.get(cfg.id);
            const position = rec?.rppPosition || cfg.rppPosition || snapshot?.rppPosition || "未測定";
            const positionKeyword = representativeKeyword(cfg, snapshot);
            const positionRows = (cfg.rppPositions || snapshot?.rppPositions || (positionKeyword ? [{ keyword: positionKeyword, position }] : [])).filter((row) => row.keyword && row.position);
            const exclusionState = exclusionStateMap.get(cfg.itemCode);
            const currentExcluded = exclusionState?.currentExcluded ?? false;
            const exclusionChangedForItem = exclusionState ? currentExcluded !== exclusionState.excluded : false;
            const canUndoAccidentalExclusion = Boolean(exclusionState && exclusionState.excluded === false && currentExcluded === true);
            const itemTargetCompletion = itemTargetCompletionMap.get(cfg.itemCode) ?? { total: 1, saved: row ? 1 : 0, missing: row ? 0 : 1 };
            const canReleaseExclusion = itemTargetCompletion.saved > 0;
            const roas = rec?.roas ?? (rec?.spend && rec.salesAmount != null ? Math.round((rec.salesAmount / rec.spend) * 100) : null);
            return (
              <article className="product-card" key={cfg.id}>
                <div className="product-row-info">
                  <div className="product-card-head">
                    <div>
                      <b>{cfg.itemCode}</b>
                      <span className="status-pill status-hold">{cfg.source}</span>
                    </div>
                    <span className="owner-mini-pill">{row?.owner || cfg.owner || "担当未設定"}</span>
                  </div>
                  <h3>{cfg.keyword}</h3>
                  <small className="product-item-name">{cfg.itemName || "商品名未取得"}</small>
                </div>
                <div className="product-card-metrics">
                  <span className="metric-muted"><small>商品CPC</small><strong>{yen(cfg.itemCpc)}</strong></span>
                  <span className="metric-muted"><small>KW CPC</small><strong>{yen(cfg.keywordCpc)}</strong></span>
                  <span><small>広告費</small><strong>{yenNumber(rec?.spend ?? 0)}</strong></span>
                  <span><small>クリック</small><strong>{(rec?.clicks ?? 0).toLocaleString("ja-JP")}</strong></span>
                  <span><small>売上</small><strong>{yenNumber(rec?.salesAmount ?? 0)}</strong></span>
                  <span><small>ROAS</small><strong>{roas == null ? "-" : `${Math.round(roas)}%`}</strong></span>
                  <span className="metric-wide position-metric"><small>検索位置{positionKeyword ? `（${positionKeyword}）` : ""}</small><strong className="position-value">{positionParts(position).map((part) => <span key={`${part.device}-${part.status}`}><b>{part.device}</b><em>{part.status}</em></span>)}</strong></span>
                  {positionRows.length > 1 ? <span className="metric-wide position-list"><small>検索KW別</small><strong>{positionRows.map((row) => `${row.keyword}: ${row.position}`).join(" / ")}</strong></span> : null}
                </div>
                <div className="product-card-status">
                  {row ? <small>検索調査KW {(row.searchKeywords ?? []).join(" / ") || "未設定"}<br />CTR {row.ctrGoal}% / CVR {row.cvrGoal}% / ROAS最低 {row.roasFloor}%<br />PC {positionGoalLabel(row.pcPositionGoal ?? row.positionGoal)} / SP {positionGoalLabel(row.spPositionGoal ?? row.positionGoal)} / {row.policy}</small> : <div className="target-status-compact"><span className="status-pill approval-held">目標未設定</span><small>商品内 {itemTargetCompletion.saved}/{itemTargetCompletion.total}件</small></div>}
                </div>
                <div className="approval-actions card-actions">
                  <div className="product-exclusion-action">
                    <span className={`status-pill ${currentExcluded ? "approval-rejected" : "status-approved"}`}>{currentExcluded ? "除外ON" : "配信中"}</span>
                    {exclusionChangedForItem ? <small>CSV変更予定</small> : null}
                    <button
                      disabled={busy || (currentExcluded && !canReleaseExclusion && !canUndoAccidentalExclusion)}
                      type="button"
                      onClick={() => toggleExcluded(cfg.itemCode, canReleaseExclusion)}
                      title={currentExcluded && !canReleaseExclusion && !canUndoAccidentalExclusion ? "この商品に目標が1つ以上入るまで除外解除できません" : undefined}
                    >
                      {exclusionChangedForItem ? "元に戻す" : currentExcluded ? "除外解除" : "広告除外ON"}
                    </button>
                  </div>
                  <button disabled={busy} type="button" onClick={() => openTargetForm(row ? toForm(row) : configuredToForm(cfg))}>目標設定</button>
                  <button disabled={busy} type="button" onClick={() => downloadCpcCsv(cfg)}>CPC調整</button>
                  {row ? <button disabled={busy} type="button" onClick={() => deleteTarget(row.id)}>削除</button> : null}
                </div>
              </article>
            );
          })}
          {!filteredConfiguredTargets.length ? <p>この担当のRPP設定中商品/KWはありません。</p> : null}
        </div>
        {excludedProductsForOwner.length ? (
          <div className="excluded-product-block">
            <div className="section-heading compact-heading">
              <div>
                <h3>除外中商品（広告ON戻し）</h3>
                <p>除外中の商品を広告ONに戻すには、商品内に目標が1つ以上必要です。</p>
              </div>
              <button className="secondary-button compact-button" type="button" onClick={() => setShowExcludedProducts((current) => !current)}>
                {showExcludedProducts ? "閉じる" : `開く（除外中 ${excludedProductsForOwner.length}件）`}
              </button>
            </div>
            {showExcludedProducts ? (
              <>
            <label className="excluded-search">商品検索<input value={exclusionSearch} onChange={(e) => setExclusionSearch(e.target.value)} placeholder="商品番号・商品名・担当で検索" /></label>
            <div className="excluded-product-grid">
              {filteredExcludedProducts.slice(0, 80).map((row) => {
                const savedCount = savedTargetCountByItemCode.get(row.itemCode) ?? 0;
                const canTurnOn = savedCount > 0;
                const changed = row.currentExcluded !== row.excluded;
                return (
                  <article className="excluded-product-row" key={row.itemCode}>
                    <div><b>{row.itemCode}</b><br /><small>{row.itemName || "商品名未取得"}</small><br /><small>{row.owner || "担当未設定"}</small></div>
                    <span><small>商品CPC</small><strong>{yen(row.itemCpc)}</strong></span>
                    <span><small>保存目標</small><strong>{savedCount}件</strong></span>
                    <div className="card-actions excluded-actions">
                      <button disabled={busy || !canTurnOn} type="button" onClick={() => toggleExcluded(row.itemCode, canTurnOn)} title={!canTurnOn ? "先に目標設定を1つ作成してください" : undefined}>{changed ? "元に戻す" : "広告ONに戻す"}</button>
                      <button disabled={busy} type="button" onClick={() => openTargetForm(excludedProductToForm(row))}>目標設定</button>
                    </div>
                  </article>
                );
              })}
              {!filteredExcludedProducts.length ? <p>検索に一致する除外中商品はありません。</p> : null}
            </div>
            {filteredExcludedProducts.length > 80 ? <p>除外中商品は先頭80件だけ表示しています。担当タブで絞り込んでください。</p> : null}
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      <div className="grid two target-grid">
        <form className="target-form" ref={targetFormRef} onSubmit={saveTarget}>
          <div className="form-row two-cols">
            <label>商品管理番号<input value={form.itemCode} onChange={(e) => patchForm("itemCode", e.target.value)} placeholder="r0606" required /></label>
            <label>RPP設定KW<input value={form.keyword} onChange={(e) => patchForm("keyword", e.target.value)} placeholder="まな板 / 商品CPC" required /></label>
          </div>
          <div className="target-form-field">
            <span>検索調査キーワード</span>
            <div className="keyword-candidate-box">
              <b>KW候補</b>
              <div className="search-word-chips">
                {searchWordOptions.length ? searchWordOptions.map((word) => <button type="button" key={word} onClick={() => addSearchWord(word)}>＋ {word}</button>) : <small>候補なし。直接入力できます。</small>}
              </div>
            </div>
            <textarea value={form.searchKeywords} onChange={(e) => patchForm("searchKeywords", e.target.value)} placeholder="候補を押すか、検索したいKWを改行で入力\n例: まな板\nまな板 フチ付き\nかまぼこ型 まな板" />
            <small>候補はSEO検索対策KW・RPP設定KW・代表KWから表示します。複数KWは改行/カンマ区切りで保存できます。</small>
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
          <div className="form-row five-cols">
            <label>CTR目標<input type="number" min="0" step="0.1" value={form.ctrGoal} onChange={(e) => patchForm("ctrGoal", e.target.value)} /></label>
            <label>CVR目標<input type="number" min="0" step="0.1" value={form.cvrGoal} onChange={(e) => patchForm("cvrGoal", e.target.value)} /></label>
            <label>ROAS最低<input type="number" min="0" step="10" value={form.roasFloor} onChange={(e) => patchForm("roasFloor", e.target.value)} /></label>
            <label>PC検索位置目標
              <select value={form.pcPositionGoal} onChange={(e) => patchForm("pcPositionGoal", e.target.value as RppPositionGoal)}>
                {PC_POSITION_GOAL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label>SP検索位置目標
              <select value={form.spPositionGoal} onChange={(e) => patchForm("spPositionGoal", e.target.value as RppPositionGoal)}>
                {POSITION_GOAL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
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
            <li><b>検索位置</b><small>「圏外」=PR枠はあるが自社広告が1ページ目に出ていない。「広告枠なし」=その検索KWで楽天側のRPP広告枠自体が出ていない。</small></li>
            <li><b>担当別保存済み</b><small>{Object.entries(grouped).map(([owner, count]) => `${owner}:${count}`).join(" / ") || "未設定"}</small></li>
          </ul>
        </div>
      </div>

    </div>
  );
}
