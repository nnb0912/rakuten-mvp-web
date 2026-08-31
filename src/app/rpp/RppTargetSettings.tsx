"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import configuredTargetsSnapshot from "@/data/rpp_configured_targets.json";
import seoKeywords from "@/data/seo_keywords.json";
import { buildRppOptimizationPreview, type RppOptimizationMode } from "@/lib/rppOptimization";
import type { RppRecommendationWithApproval } from "@/lib/rppRecommendations";
import type { RppAlertTarget, RppConfiguredTarget, RppExclusionProduct, RppOperationPolicy, RppPositionGoal, RppProtectionType } from "@/lib/rppTargets";
import type { RppExperimentRecord } from "@/lib/rppExperiments";

type Props = {
  initialTargets: RppAlertTarget[];
  configuredTargets: RppConfiguredTarget[];
  exclusionProducts: RppExclusionProduct[];
  recommendations: RppRecommendationWithApproval[];
  initialExperiments: RppExperimentRecord[];
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
  adGroup: string;
  changeLocked: boolean;
  lockReason: string;
  protectionType: RppProtectionType;
  optimizationMode: RppOptimizationMode;
  fixedCpc: string;
  maxCpc: string;
  experimentEndDate: string;
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
  adGroup: "通常",
  changeLocked: false,
  lockReason: "",
  protectionType: "NORMAL",
  optimizationMode: "ROAS",
  fixedCpc: "",
  maxCpc: "",
  experimentEndDate: "",
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
    adGroup: row.adGroup || "通常",
    changeLocked: row.changeLocked === true,
    lockReason: row.lockReason || "",
    protectionType: row.protectionType || (row.changeLocked ? "LOCKED" : "NORMAL"),
    optimizationMode: row.optimizationMode || "ROAS",
    fixedCpc: row.fixedCpc == null ? "" : String(row.fixedCpc),
    maxCpc: row.maxCpc == null ? "" : String(row.maxCpc),
    experimentEndDate: row.experimentEndDate || "",
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
  return { ...blank, itemCode: row.itemCode, keyword: row.keyword, searchKeywords: defaultSearchKeyword, owner: row.owner ?? "", adGroup: "通常" };
}

function optimizationModeLabel(mode: RppOptimizationMode) {
  if (mode === "POSITION") return "順位目標";
  if (mode === "FIXED") return "CPC固定";
  return "ROAS逆算";
}

function experimentStatusLabel(status: RppExperimentRecord["status"]) {
  if (status === "COMPLETED") return "終了";
  if (status === "EXPIRED") return "終了実績待ち";
  return "実験中";
}

function experimentMetric(value: number | null, suffix = "%") {
  return value == null ? "-" : `${Math.round(value * 10) / 10}${suffix}`;
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

export default function RppTargetSettings({ initialTargets, configuredTargets, exclusionProducts, recommendations, initialExperiments }: Props) {
  const [targets, setTargets] = useState(initialTargets);
  const [form, setForm] = useState<FormState>(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [ownerFilter, setOwnerFilter] = useState("全て");
  const [groupFilter, setGroupFilter] = useState("全て");
  const [exclusionSearch, setExclusionSearch] = useState("");
  const [showExcludedProducts, setShowExcludedProducts] = useState(false);
  const [baseExclusionProducts, setBaseExclusionProducts] = useState(exclusionProducts);
  const [exclusionOverrides, setExclusionOverrides] = useState<Record<string, boolean>>({});
  const [selectedOptimizationIds, setSelectedOptimizationIds] = useState<Set<string>>(() => new Set());
  const [experiments, setExperiments] = useState<RppExperimentRecord[]>(initialExperiments);
  const targetFormRef = useRef<HTMLFormElement | null>(null);

  async function refreshExperiments() {
    const response = await fetch("/api/rpp/experiments", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "実験履歴の取得に失敗しました");
    setExperiments(data.experiments ?? []);
  }


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
  const adGroups = useMemo(() => {
    const groups = new Set<string>(["通常"]);
    for (const row of targets) groups.add(row.adGroup || "通常");
    return ["全て", ...[...groups].sort((a, b) => a.localeCompare(b, "ja"))];
  }, [targets]);
  const recommendationMap = useMemo(() => new Map(recommendations.map((row) => [metricKey(row.itemCode, row.keyword), row])), [recommendations]);
  const optimizationPreviews = useMemo(() => configuredTargets.map((cfg) => {
    const target = targetMap.get(cfg.id);
    const rec = recommendationMap.get(metricKey(cfg.itemCode, cfg.keyword));
    const currentCpc = cfg.source === "商品CPC" ? cfg.itemCpc : cfg.keywordCpc;
    const preview = buildRppOptimizationPreview({
      mode: target?.optimizationMode || "ROAS",
      cpcKind: cfg.source === "商品CPC" ? "ITEM" : "KEYWORD",
      currentCpc,
      actualRoas: rec?.roas ?? (rec?.spend && rec.salesAmount != null ? (rec.salesAmount / rec.spend) * 100 : null),
      targetRoas: target?.roasFloor ?? 500,
      spend: rec?.spend ?? null,
      sales: rec?.salesAmount ?? null,
      positionSuggestedCpc: rec?.proposedCpc ?? null,
      fixedCpc: target?.fixedCpc ?? null,
      maxCpc: target?.maxCpc ?? null,
      changeLocked: target?.changeLocked,
      protectionType: target?.protectionType,
      experimentEndDate: target?.experimentEndDate,
    });
    return { cfg, target, rec, preview };
  }), [configuredTargets, recommendationMap, targetMap]);
  const optimizationPreviewMap = useMemo(() => new Map(optimizationPreviews.map((row) => [row.cfg.id, row])), [optimizationPreviews]);
  const actionableOptimizationPreviews = optimizationPreviews.filter((row) => row.preview.proposedCpc != null && row.preview.proposedCpc !== row.preview.currentCpc);
  const selectedOptimizationPreviews = actionableOptimizationPreviews.filter((row) => selectedOptimizationIds.has(row.cfg.id));
  const selectedSavings = selectedOptimizationPreviews.reduce((sum, row) => sum + (row.preview.savings ?? 0), 0);
  const selectedProjectedSpend = selectedOptimizationPreviews.reduce((sum, row) => sum + (row.preview.projectedSpend ?? 0), 0);
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
  const exclusionRows = useMemo(() => baseExclusionProducts.map((row) => ({
    ...row,
    currentExcluded: exclusionOverrides[row.itemCode] ?? row.excluded,
  })), [baseExclusionProducts, exclusionOverrides]);
  const exclusionStateMap = useMemo(() => new Map(exclusionRows.map((row) => [row.itemCode, row])), [exclusionRows]);
  const filteredConfiguredTargets = configuredTargets.filter((cfg) => {
    const target = targetMap.get(cfg.id);
    const ownerOk = ownerFilter === "全て" || (target?.owner || cfg.owner || "担当未設定") === ownerFilter;
    const groupOk = groupFilter === "全て" || (target?.adGroup || "通常") === groupFilter;
    return ownerOk && groupOk;
  });
  const visibleOwnerStats = ownerFilter === "全て" ? ownerStats : ownerStats.filter((row) => row.owner === ownerFilter);
  const exclusionChanged = exclusionRows.filter((row) => row.currentExcluded !== row.excluded);
  const excludedProductsForOwner = exclusionRows.filter((row) => row.excluded && (ownerFilter === "全て" || (row.owner || "担当未設定") === ownerFilter));
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
    return { ...blank, itemCode: row.itemCode, keyword: "商品CPC", owner: row.owner ?? "", adGroup: "通常", searchKeywords: seoWordsForItem(row.itemCode)[0] ?? "" };
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

  function toggleOptimizationSelection(id: string) {
    setSelectedOptimizationIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function downloadOptimizationPreviewPair() {
    if (!selectedOptimizationPreviews.length) return;
    const header = ["種別", "商品管理番号", "キーワード", "現在CPC", "提案CPC", "削減見込み", "改善後ROAS"];
    const rows = selectedOptimizationPreviews.map(({ cfg, preview }) => [
      cfg.source,
      cfg.itemCode,
      cfg.keyword,
      String(preview.currentCpc),
      String(preview.proposedCpc),
      String(Math.round(preview.savings ?? 0)),
      preview.projectedRoas == null ? "" : String(Math.round(preview.projectedRoas)),
    ]);
    const rollbackRows = selectedOptimizationPreviews.map(({ cfg, preview }) => [cfg.source, cfg.itemCode, cfg.keyword, String(preview.proposedCpc), String(preview.currentCpc), "", ""]);
    const ymd = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    const toCsv = (data: string[][]) => `\uFEFF${[header, ...data].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
    downloadTextFile(`rpp_optimization_preview_${ymd}.csv`, toCsv(rows));
    downloadTextFile(`rpp_optimization_rollback_${ymd}.csv`, toCsv(rollbackRows));
    setMessage(`提案用・戻し用CSVを対で出力しました（${selectedOptimizationPreviews.length}件）。RMS反映はしていません。`);
  }

  function downloadExcludeCsv() {
    const changes = exclusionChanged.map((row) => [row.currentExcluded ? "n" : "d", row.itemCode]);
    const lines = ["コントロールカラム,商品管理番号", ...changes.map((row) => row.map(csvCell).join(","))];
    downloadTextFile(`rpp_exclude_diff_${new Date().toISOString().slice(0, 10).replaceAll("-", "")}.csv`, `\uFEFF${lines.join("\r\n")}\r\n`);
    setMessage(`RMS手動アップロード用CSVを出力しました（変更 ${changes.length}商品 / n=除外登録, d=除外解除）`);
  }

  function downloadCpcCsv(cfg: RppConfiguredTarget) {
    const target = targetMap.get(cfg.id);
    if (target?.changeLocked || target?.protectionType === "BLOCK") {
      setError(`変更不可リスト対象です${target.lockReason ? `（${target.lockReason}）` : ""}`);
      return;
    }
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
      if (form.optimizationMode !== "ROAS" && !form.experimentEndDate) {
        throw new Error("順位目標・CPC固定モードでは実験終了日が必須です");
      }
      const payload = {
        ...form,
        changeLocked: form.protectionType === "LOCKED",
        positionGoal: form.pcPositionGoal,
        searchKeywords: form.searchKeywords.split(/[\n,、]+/).map((kw) => kw.trim()).filter(Boolean),
        ctrGoal: Number(form.ctrGoal),
        cvrGoal: Number(form.cvrGoal),
        roasFloor: Number(form.roasFloor),
        fixedCpc: form.fixedCpc.trim() ? Number(form.fixedCpc) : null,
        maxCpc: form.maxCpc.trim() ? Number(form.maxCpc) : null,
        experimentStartedAt: form.optimizationMode === "ROAS" ? "" : (targetMap.get(`${encodeURIComponent(form.itemCode.toLowerCase())}__${encodeURIComponent(form.keyword)}`)?.experimentStartedAt || new Date().toISOString()),
        experimentBaseline: (() => {
          const id = `${encodeURIComponent(form.itemCode.toLowerCase())}__${encodeURIComponent(form.keyword)}`;
          const existing = targetMap.get(id)?.experimentBaseline;
          if (form.optimizationMode === "ROAS") return null;
          if (existing) return existing;
          const rec = recommendationMap.get(metricKey(form.itemCode, form.keyword));
          const position = rec?.rppPosition || "";
          return { capturedAt: new Date().toISOString(), ctr: null, cvr: rec?.cvr ?? null, roas: rec?.roas ?? null, pcPosition: position, spPosition: position };
        })(),
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
      let historySaved = false;
      if (payload.optimizationMode !== "ROAS" && payload.experimentBaseline) {
        const historyResponse = await fetch("/api/rpp/experiments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetId: data.target.id,
            itemCode: data.target.itemCode,
            keyword: data.target.keyword,
            optimizationMode: payload.optimizationMode,
            endDate: payload.experimentEndDate,
            startedAt: data.target.experimentStartedAt,
            baseline: payload.experimentBaseline,
            settings: {
              fixedCpc: payload.fixedCpc,
              maxCpc: payload.maxCpc,
              pcPositionGoal: payload.pcPositionGoal,
              spPositionGoal: payload.spPositionGoal,
              ctrGoal: payload.ctrGoal,
              cvrGoal: payload.cvrGoal,
              roasFloor: payload.roasFloor,
            },
          }),
        });
        const historyData = await historyResponse.json();
        if (!historyResponse.ok) throw new Error(`目標は保存しましたが実験履歴の作成に失敗しました: ${historyData.error ?? "不明"}`);
        historySaved = true;
        await refreshExperiments();
      }
      setForm(blank);
      setMessage(historySaved ? "目標と実験開始スナップショットを保存しました" : "保存しました");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function finishExperiment(experiment: RppExperimentRecord) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const rec = recommendationMap.get(metricKey(experiment.itemCode, experiment.keyword));
      const position = rec?.rppPosition || "未測定";
      const parts = positionParts(position);
      const response = await fetch("/api/rpp/experiments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: experiment.id,
          result: {
            capturedAt: new Date().toISOString(),
            ctr: null,
            cvr: rec?.cvr ?? null,
            roas: rec?.roas ?? null,
            pcPosition: parts.find((part) => part.device === "PC")?.status || position,
            spPosition: parts.find((part) => part.device === "SP")?.status || position,
          },
          note: experiment.status === "EXPIRED" ? "終了日到来後に最新実績を取得" : "運用画面から終了実績を取得",
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "終了実績の保存に失敗しました");
      await refreshExperiments();
      setMessage(`${experiment.itemCode} / ${experiment.keyword} の終了実績を保存しました`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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
        body: JSON.stringify({ action: "seedMissing", ctrGoal: 5, cvrGoal: 5, roasFloor: 500, positionGoal: "FIRST_PAGE", pcPositionGoal: "FIRST_PAGE", spPositionGoal: "TOP_7", policy: "維持", adGroup: "通常", protectionType: "NORMAL", changeLocked: false, lockReason: "" }),
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

  return (
    <div className="target-settings">
      {error ? <p className="error-box">{error}</p> : null}
      {message ? <p className="success-box">{message}</p> : null}
      <div className="grid cards target-summary-cards">
        <div className="card"><span>RPP設定中</span><strong>{configuredTargets.length}</strong></div>
        <div className="card"><span>目標保存済み</span><strong>{targets.length}</strong></div>
        <div className="card"><span>目標未設定</span><strong className={missingCount ? "warn-text" : "ok-text"}>{missingCount}</strong></div>
        <div className="card"><span>担当タブ</span><strong>{ownerFilter}</strong></div>
        <div className="card"><span>広告グループ</span><strong>{groupFilter}</strong></div>
        <div className="card"><span>保護設定</span><strong>{targets.filter((row) => row.protectionType && row.protectionType !== "NORMAL").length}</strong></div>
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
        <div className="owner-tabs group-tabs">
          {adGroups.map((group) => (
            <button className={groupFilter === group ? "owner-tab active" : "owner-tab"} key={group} type="button" onClick={() => setGroupFilter(group)}>
              {group}<small>{group === "全て" ? configuredTargets.length : configuredTargets.filter((cfg) => (targetMap.get(cfg.id)?.adGroup || "通常") === group).length}件</small>
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
            <p>担当タブ・広告グループに合わせて、この一覧だけが切り替わります。</p>
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
        <div className="optimization-preview-bar">
          <div className="optimization-preview-main">
            <div className="optimization-preview-title">
              <div><b>最適化プレビュー</b><small>実績を分析し、ルールで判断してから提案します。RMSには自動反映しません。</small></div>
              <div className="optimization-flow" aria-label="最適化フロー"><span>分析</span><i>→</i><span>判断</span><i>→</i><span>提案</span></div>
            </div>
            <div className="optimization-summary-grid">
              <span><small>候補</small><strong>{actionableOptimizationPreviews.length}件</strong></span>
              <span><small>選択</small><strong>{selectedOptimizationPreviews.length}件</strong></span>
              <span><small>予測広告費</small><strong>{yenNumber(selectedProjectedSpend)}</strong></span>
              <span className={selectedSavings >= 0 ? "saving-positive" : "saving-negative"}><small>削減見込み</small><strong>{yenNumber(selectedSavings)}</strong></span>
            </div>
          </div>
          <div className="product-list-actions">
            <button className="secondary-button compact-button" type="button" disabled={!actionableOptimizationPreviews.length} onClick={() => setSelectedOptimizationIds(new Set(actionableOptimizationPreviews.map((row) => row.cfg.id)))}>候補を全選択</button>
            <button className="secondary-button compact-button" type="button" disabled={!selectedOptimizationPreviews.length} onClick={() => setSelectedOptimizationIds(new Set())}>選択解除</button>
            <button className="primary-button compact-button" type="button" disabled={!selectedOptimizationPreviews.length} onClick={downloadOptimizationPreviewPair}>提案＋戻しCSV</button>
          </div>
        </div>
        <div className="adant-ops-table-wrap">
          <table className="adant-ops-table">
            <thead>
              <tr>
                <th className="select-col">選択</th>
                <th className="product-col">商品 / キーワード</th>
                <th>担当 / G</th>
                <th>実績</th>
                <th>CPC</th>
                <th>ROAS</th>
                <th>検索順位</th>
                <th>運用モード</th>
                <th>保護</th>
                <th>配信</th>
                <th className="actions-col">操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredConfiguredTargets.map((cfg) => {
                const row = targetMap.get(cfg.id);
                const rec = recommendationMap.get(metricKey(cfg.itemCode, cfg.keyword));
                const snapshot = positionSnapshotMap.get(cfg.id);
                const position = rec?.rppPosition || cfg.rppPosition || snapshot?.rppPosition || "未測定";
                const positionKeyword = representativeKeyword(cfg, snapshot);
                const exclusionState = exclusionStateMap.get(cfg.itemCode);
                const currentExcluded = exclusionState?.currentExcluded ?? false;
                const exclusionChangedForItem = exclusionState ? currentExcluded !== exclusionState.excluded : false;
                const canUndoAccidentalExclusion = Boolean(exclusionState && exclusionState.excluded === false && currentExcluded === true);
                const itemTargetCompletion = itemTargetCompletionMap.get(cfg.itemCode) ?? { total: 1, saved: row ? 1 : 0, missing: row ? 0 : 1 };
                const canReleaseExclusion = itemTargetCompletion.saved > 0;
                const roas = rec?.roas ?? (rec?.spend && rec.salesAmount != null ? Math.round((rec.salesAmount / rec.spend) * 100) : null);
                const optimization = optimizationPreviewMap.get(cfg.id)?.preview;
                const optimizationActionable = optimization?.proposedCpc != null && optimization.proposedCpc !== optimization.currentCpc;
                const positions = positionParts(position);
                const protectionLabel = row?.protectionType && row.protectionType !== "NORMAL"
                  ? ({ BLOCK: "ブロック", WHITELIST: "ホワイト", LOCKED: "変更不可", FOCUS: "注力" }[row.protectionType])
                  : "通常";
                return (
                  <tr key={cfg.id} className={selectedOptimizationIds.has(cfg.id) ? "selected" : currentExcluded ? "excluded" : ""}>
                    <td className="select-col">
                      <label className="optimization-check icon-check" title={optimization?.blockedReason || undefined}>
                        <input aria-label={`${cfg.itemCode}を提案対象にする`} type="checkbox" checked={selectedOptimizationIds.has(cfg.id)} disabled={!optimizationActionable} onChange={() => toggleOptimizationSelection(cfg.id)} />
                      </label>
                    </td>
                    <td className="product-col">
                      <div className="adant-product-code"><b>{cfg.itemCode}</b><span>{cfg.source}</span></div>
                      <strong>{cfg.keyword}</strong>
                      <small title={cfg.itemName}>{cfg.itemName || "商品名未取得"}</small>
                    </td>
                    <td><b>{row?.owner || cfg.owner || "未設定"}</b><small>{row?.adGroup || "通常"}</small></td>
                    <td className="number-cell"><b>{yenNumber(rec?.spend ?? 0)}</b><small>{(rec?.clicks ?? 0).toLocaleString("ja-JP")} click / 売上 {yenNumber(rec?.salesAmount ?? 0)}</small></td>
                    <td className="cpc-cell">
                      <b>{optimization?.currentCpc ? `${optimization.currentCpc}円` : cfg.source === "商品CPC" ? yen(cfg.itemCpc) : yen(cfg.keywordCpc)}</b>
                      <span className={optimization?.delta == null ? "" : optimization.delta > 0 ? "cpc-up" : optimization.delta < 0 ? "cpc-down" : ""}>→ {optimization?.proposedCpc == null ? "提案なし" : `${optimization.proposedCpc}円`}</span>
                      <small>{optimization?.savings == null ? "" : `効果 ${yenNumber(optimization.savings)}`}</small>
                    </td>
                    <td className="number-cell"><b>{roas == null ? "-" : `${Math.round(roas)}%`}</b><small>→ {optimization?.projectedRoas == null ? "-" : `${Math.round(optimization.projectedRoas)}%`}</small></td>
                    <td className="rank-cell" title={positionKeyword || undefined}>{positions.map((part) => <span key={`${part.device}-${part.status}`}><b>{part.device}</b><em>{part.status}</em></span>)}</td>
                    <td><span className={`optimization-mode-pill mode-${(row?.optimizationMode || "ROAS").toLowerCase()}`}>{optimizationModeLabel(row?.optimizationMode || "ROAS")}</span><small>{row?.experimentEndDate ? `〜${row.experimentEndDate}` : `目標 ${row?.roasFloor ?? 500}%`}</small></td>
                    <td><span className={`protection-pill protection-${(row?.protectionType || "NORMAL").toLowerCase()}`}>{protectionLabel}</span><small>{row?.lockReason || ""}</small></td>
                    <td><span className={`delivery-dot ${currentExcluded ? "off" : "on"}`}><i />{currentExcluded ? "除外ON" : "配信中"}</span>{exclusionChangedForItem ? <small className="pending-change">変更予定</small> : null}</td>
                    <td className="actions-col">
                      <button disabled={busy} type="button" onClick={() => openTargetForm(row ? toForm(row) : configuredToForm(cfg))}>設定</button>
                      <button disabled={busy || row?.changeLocked === true || row?.protectionType === "BLOCK"} type="button" onClick={() => downloadCpcCsv(cfg)} title={row?.changeLocked || row?.protectionType === "BLOCK" ? "変更対象外です" : undefined}>CPC</button>
                      <button className={currentExcluded ? "restore-button" : "danger-ghost"} disabled={busy || (currentExcluded && !canReleaseExclusion && !canUndoAccidentalExclusion)} type="button" onClick={() => toggleExcluded(cfg.itemCode, canReleaseExclusion)} title={currentExcluded && !canReleaseExclusion && !canUndoAccidentalExclusion ? "この商品に目標が1つ以上入るまで除外解除できません" : undefined}>{exclusionChangedForItem ? "戻す" : currentExcluded ? "再開" : "除外"}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!filteredConfiguredTargets.length ? <p>この担当のRPP設定中商品/KWはありません。</p> : null}
        </div>
        {excludedProductsForOwner.length ? (
          <div className="excluded-product-block" id="rpp-excluded">
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

      <section className="panel experiment-history-panel" id="rpp-experiments">
        <div className="section-heading compact-heading">
          <div><h2>実験トラッキング</h2><p>順位目標・CPC固定の開始値を保存し、終了時に同じ指標で比較します。</p></div>
          <div className="experiment-summary">
            <span>実験中 <b>{experiments.filter((row) => row.status === "ACTIVE").length}</b></span>
            <span>終了実績待ち <b>{experiments.filter((row) => row.status === "EXPIRED").length}</b></span>
            <span>終了 <b>{experiments.filter((row) => row.status === "COMPLETED").length}</b></span>
          </div>
        </div>
        {experiments.length ? (
          <div className="experiment-table-wrap">
            <table className="experiment-table">
              <thead><tr><th>商品 / KW</th><th>モード・期間</th><th>開始値</th><th>終了値</th><th>状態</th><th>操作</th></tr></thead>
              <tbody>{experiments.slice(0, 30).map((experiment) => (
                <tr key={experiment.id}>
                  <td><b>{experiment.itemCode}</b><small>{experiment.keyword}</small></td>
                  <td><span className={`optimization-mode-pill mode-${experiment.optimizationMode.toLowerCase()}`}>{optimizationModeLabel(experiment.optimizationMode)}</span><small>{experiment.startedAt.slice(0, 10)} → {experiment.endDate}</small></td>
                  <td><b>CVR {experimentMetric(experiment.baseline.cvr)} / ROAS {experimentMetric(experiment.baseline.roas)}</b><small>PC {experiment.baseline.pcPosition || "-"} / SP {experiment.baseline.spPosition || "-"}</small></td>
                  <td><b>CVR {experimentMetric(experiment.result?.cvr ?? null)} / ROAS {experimentMetric(experiment.result?.roas ?? null)}</b><small>PC {experiment.result?.pcPosition || "-"} / SP {experiment.result?.spPosition || "-"}</small></td>
                  <td><span className={`experiment-status status-${experiment.status.toLowerCase()}`}>{experimentStatusLabel(experiment.status)}</span></td>
                  <td><button disabled={busy || experiment.status === "COMPLETED"} type="button" onClick={() => finishExperiment(experiment)}>{experiment.status === "EXPIRED" ? "終了実績を取得" : experiment.status === "ACTIVE" ? "今すぐ終了" : "記録済み"}</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p className="experiment-empty">順位目標またはCPC固定モードを保存すると、ここに開始スナップショットが追加されます。</p>}
      </section>

      <div className="grid two target-grid">
        <form className="target-form" id="rpp-target-form" ref={targetFormRef} onSubmit={saveTarget}>
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
            <label>広告グループ<input list="rpp-ad-groups" value={form.adGroup} onChange={(e) => patchForm("adGroup", e.target.value)} placeholder="通常 / 注力 / 季節 / 利益重視" /></label>
            <datalist id="rpp-ad-groups">{adGroups.filter((g) => g !== "全て").map((g) => <option key={g} value={g} />)}</datalist>
          </div>
          <div className="form-row two-cols">
            <label>保護区分
              <select value={form.protectionType} onChange={(e) => patchForm("protectionType", e.target.value as RppProtectionType)}>
                <option value="NORMAL">通常</option>
                <option value="BLOCK">ブロック（完全対象外）</option>
                <option value="WHITELIST">ホワイト（除外判定から保護）</option>
                <option value="LOCKED">変更不可（CPC固定）</option>
                <option value="FOCUS">注力（上限内で積極運用）</option>
              </select>
            </label>
            <label>保護理由<input value={form.lockReason} onChange={(e) => patchForm("lockReason", e.target.value)} placeholder="セール中 / 戦略商品 / 要確認" disabled={form.protectionType === "NORMAL"} /></label>
          </div>
          <div className="form-row two-cols">
            <label>運用方針
              <select value={form.policy} onChange={(e) => patchForm("policy", e.target.value as RppOperationPolicy)}>
                <option value="攻め">攻め</option>
                <option value="維持">維持</option>
                <option value="テスト">テスト</option>
                <option value="停止候補">停止候補</option>
              </select>
            </label>
          </div>
          <div className="optimization-mode-selector">
            <span>最適化モード</span>
            <div className="optimization-mode-options">
              <button className={form.optimizationMode === "ROAS" ? "active mode-roas" : "mode-roas"} type="button" onClick={() => patchForm("optimizationMode", "ROAS")}><b>ROAS逆算</b><small>通常運用・利益重視</small></button>
              <button className={form.optimizationMode === "POSITION" ? "active mode-position" : "mode-position"} type="button" onClick={() => patchForm("optimizationMode", "POSITION")}><b>順位目標</b><small>PC/SP露出実験</small></button>
              <button className={form.optimizationMode === "FIXED" ? "active mode-fixed" : "mode-fixed"} type="button" onClick={() => patchForm("optimizationMode", "FIXED")}><b>CPC固定</b><small>サムネ等の効果検証</small></button>
            </div>
          </div>
          <div className="form-row three-cols optimization-mode-fields">
            <label>固定CPC<input type="number" min="1" step="1" value={form.fixedCpc} onChange={(e) => patchForm("fixedCpc", e.target.value)} disabled={form.optimizationMode !== "FIXED"} placeholder="例 50" /></label>
            <label>CPC上限<input type="number" min="1" step="1" value={form.maxCpc} onChange={(e) => patchForm("maxCpc", e.target.value)} placeholder="未設定なら安全幅のみ" /></label>
            <label>実験終了日<input type="date" value={form.experimentEndDate} onChange={(e) => patchForm("experimentEndDate", e.target.value)} disabled={form.optimizationMode === "ROAS"} /></label>
          </div>
          <div className="form-row five-cols">
            <label>CTR目標<input type="number" min="0" step="0.1" value={form.ctrGoal} onChange={(e) => patchForm("ctrGoal", e.target.value)} /></label>
            <label>CVR目標<input type="number" min="0" step="0.1" value={form.cvrGoal} onChange={(e) => patchForm("cvrGoal", e.target.value)} /></label>
            <label>目標ROAS<input type="number" min="0" step="10" value={form.roasFloor} onChange={(e) => patchForm("roasFloor", e.target.value)} /></label>
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
            <li><b>広告グループ</b><small>{adGroups.filter((g) => g !== "全て").join(" / ") || "通常"}</small></li>
            <li><b>4保護区分</b><small>ブロック=完全対象外 / ホワイト=除外保護 / 変更不可=CPC固定 / 注力=上限内で積極運用。</small></li>
            <li><b>ROAS逆算</b><small>通常運用。目標ROASに近づくようCPCを逆算し、1回の変更を下限-50%・上限+20%に制限。</small></li>
            <li><b>順位目標</b><small>既存のPC/SP検索順位提案を利用。CPC上限とROAS実績を併記して実験判断。</small></li>
            <li><b>CPC固定</b><small>サムネ・商品名等の検証用。順位/CPC条件を固定し、CTR・CVR・ROASを比較。</small></li>
          </ul>
        </div>
      </div>

    </div>
  );
}
