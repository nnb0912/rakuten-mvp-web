"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import configuredTargetsSnapshot from "@/data/rpp_configured_targets.json";
import seoKeywords from "@/data/seo_keywords.json";
import {
  ROUTINE_OPTIMIZATION_MODES,
  buildRppOptimizationPreview,
  optimizationModeLabel,
  type RppOptimizationMode,
} from "@/lib/rppOptimization";
import type { RppRecommendationWithApproval } from "@/lib/rppRecommendations";
import { canDownloadManualCpcCsv, isAutomaticRppOptimizationMode } from "@/lib/rppCpcModePolicy";
import { shortRppItemName } from "@/lib/rppItemShortNames";
import { canOperateProductExclusion, deliveryLabel } from "@/lib/rppTargetUiRules";
import type { RppAlertTarget, RppConfiguredTarget, RppExclusionProduct, RppOperationPolicy, RppPositionGoal, RppProtectionType } from "@/lib/rppTargets";
import type { RppExperimentRecord } from "@/lib/rppExperiments";
import type { RppEditLock } from "@/lib/rppCollaboration";
import { parseRppTargetDraft, rppTargetDraftKey } from "@/lib/rppTargetDraft";
import { formatRppClicks, formatRppYen } from "@/lib/rppMetricDisplay";
import type { RppDeliveryReservation, RppDeliveryScheduleStatus, RppRecurringSchedule } from "@/lib/rppDeliverySchedules";

import { RppInfoTip } from "./RppInfoTip";
type Props = {
  initialTargets: RppAlertTarget[];
  configuredTargets: RppConfiguredTarget[];
  exclusionProducts: RppExclusionProduct[];
  initialNightPauseItemCodes: string[];
  ownerNames: string[];
  recommendations: RppRecommendationWithApproval[];
  initialExperiments: RppExperimentRecord[];
  performanceDateRange?: string | null;
  surface?: "targets" | "excluded";
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
  roasMinCpc: string;
  roasMaxCpc: string;
  positionMinCpc: string;
  positionMaxCpc: string;
  balancedMinCpc: string;
  balancedMaxCpc: string;
  experimentEndDate: string;
  note: string;
};

type EditSession = RppEditLock & { token: string; draftKey: string };
type ActiveRppOperation = { id: string; status: "pending" | "running"; actorName: string; itemCodes: string[]; createdAt: string; updatedAt: string };
const blankRecurringSchedule: RppRecurringSchedule = { enabled: false, startTime: "23:00", endTime: "07:00" };

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
  optimizationMode: "FIXED",
  fixedCpc: "",
  maxCpc: "",
  roasMinCpc: "",
  roasMaxCpc: "",
  positionMinCpc: "",
  positionMaxCpc: "",
  balancedMinCpc: "",
  balancedMaxCpc: "",
  experimentEndDate: "",
  note: "",
};

function configuredCurrentCpc(row: RppConfiguredTarget) {
  return row.source === "商品CPC" ? row.itemCpc : row.keywordCpc;
}

function toForm(row: RppAlertTarget, configured?: RppConfiguredTarget): FormState {
  const currentCpc = configured ? configuredCurrentCpc(configured) : null;
  const optimizationMode = row.optimizationMode || "FIXED";
  return {
    itemCode: row.itemCode,
    keyword: row.keyword,
    searchKeywords: (row.searchKeywords ?? []).join("\n"),
    owner: row.owner,
    ctrGoal: String(row.ctrGoal),
    cvrGoal: String(row.cvrGoal),
    roasFloor: String(row.baseRoasFloor ?? row.roasFloor),
    positionGoal: row.positionGoal,
    pcPositionGoal: row.pcPositionGoal ?? row.positionGoal,
    spPositionGoal: row.spPositionGoal ?? row.positionGoal,
    policy: row.policy,
    adGroup: row.adGroup || "通常",
    changeLocked: row.changeLocked === true,
    lockReason: row.lockReason || "",
    protectionType: row.protectionType || (row.changeLocked ? "LOCKED" : "NORMAL"),
    optimizationMode,
    fixedCpc: row.fixedCpc == null ? (optimizationMode === "FIXED" && currentCpc != null ? String(currentCpc) : "") : String(row.fixedCpc),
    maxCpc: row.maxCpc == null ? "" : String(row.maxCpc),
    roasMinCpc: row.roasMinCpc == null ? "" : String(row.roasMinCpc),
    roasMaxCpc: row.roasMaxCpc == null ? "" : String(row.roasMaxCpc),
    positionMinCpc: row.positionMinCpc == null ? "" : String(row.positionMinCpc),
    positionMaxCpc: row.positionMaxCpc == null ? "" : String(row.positionMaxCpc),
    balancedMinCpc: row.balancedMinCpc == null ? "" : String(row.balancedMinCpc),
    balancedMaxCpc: row.balancedMaxCpc == null ? "" : String(row.balancedMaxCpc),
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
  const currentCpc = configuredCurrentCpc(row);
  return { ...blank, itemCode: row.itemCode, keyword: row.keyword, searchKeywords: defaultSearchKeyword, owner: row.owner ?? "", adGroup: "通常", optimizationMode: "FIXED", fixedCpc: currentCpc == null ? "" : String(currentCpc) };
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

type ModeBoundField = "roasMinCpc" | "roasMaxCpc" | "positionMinCpc" | "positionMaxCpc" | "balancedMinCpc" | "balancedMaxCpc";

function modeBoundFields(mode: RppOptimizationMode): { minimum: ModeBoundField; maximum: ModeBoundField } | null {
  if (mode === "ROAS") return { minimum: "roasMinCpc", maximum: "roasMaxCpc" };
  if (mode === "POSITION") return { minimum: "positionMinCpc", maximum: "positionMaxCpc" };
  if (mode === "BALANCED") return { minimum: "balancedMinCpc", maximum: "balancedMaxCpc" };
  return null;
}

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

export default function RppTargetSettings({ initialTargets, configuredTargets, exclusionProducts, initialNightPauseItemCodes, ownerNames, recommendations, initialExperiments, performanceDateRange, surface = "targets" }: Props) {
  const [targets, setTargets] = useState(initialTargets);
  const [form, setForm] = useState<FormState>(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [ownerFilter, setOwnerFilter] = useState("全て");
  const [groupFilter, setGroupFilter] = useState("全て");
  const [tableSearch, setTableSearch] = useState("");
  const [tableStatusFilter, setTableStatusFilter] = useState<"ALL" | "CANDIDATE" | "ATTENTION" | "EXCLUDED">("ALL");
  const [modeFilter, setModeFilter] = useState<"ALL" | RppOptimizationMode>("ALL");
  const [protectionFilter, setProtectionFilter] = useState<"ALL" | RppProtectionType>("ALL");
  const [formDrawerOpen, setFormDrawerOpen] = useState(false);

  const [baseExclusionProducts] = useState(exclusionProducts);
  const [exclusionOverrides, setExclusionOverrides] = useState<Record<string, boolean>>({});
  const [selectedOptimizationIds, setSelectedOptimizationIds] = useState<Set<string>>(() => new Set());
  const [experiments, setExperiments] = useState<RppExperimentRecord[]>(initialExperiments);
  const [editSession, setEditSession] = useState<EditSession | null>(null);
  const [activeEditLocks, setActiveEditLocks] = useState<RppEditLock[]>([]);
  const [activeOperations, setActiveOperations] = useState<ActiveRppOperation[]>([]);
  const [draftStatus, setDraftStatus] = useState("");
  const [nightPauseItemCodes, setNightPauseItemCodes] = useState<Set<string>>(() => new Set(initialNightPauseItemCodes));
  const [nightPauseBusyItemCode, setNightPauseBusyItemCode] = useState<string | null>(null);
  const [schedulePanelItemCode, setSchedulePanelItemCode] = useState<string | null>(null);
  const [scheduleRecurring, setScheduleRecurring] = useState<RppRecurringSchedule>(blankRecurringSchedule);
  const [scheduleUpdatedAt, setScheduleUpdatedAt] = useState<string | null>(null);
  const [scheduleStatus, setScheduleStatus] = useState<RppDeliveryScheduleStatus | null>(null);
  const [scheduleReservations, setScheduleReservations] = useState<RppDeliveryReservation[]>([]);
  const [scheduleReservationAction, setScheduleReservationAction] = useState<"ON" | "OFF">("OFF");
  const [scheduleReservationAt, setScheduleReservationAt] = useState("");
  const [scheduleBusy, setScheduleBusy] = useState(false);
  useEffect(() => {
    if (!schedulePanelItemCode) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSchedulePanelItemCode(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [schedulePanelItemCode]);
  useEffect(() => {
    if (!schedulePanelItemCode) return;
    const refreshRuntimeStatus = async () => {
      try {
        const response = await fetch(`/api/rpp/delivery-schedules?itemCode=${encodeURIComponent(schedulePanelItemCode)}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json();
        setScheduleReservations(Array.isArray(data.reservations) ? data.reservations : []);
        setScheduleStatus(Array.isArray(data.statuses) ? data.statuses.find((row: RppDeliveryScheduleStatus) => row.itemCode === schedulePanelItemCode) ?? null : null);
      } catch {
        // Keep the editable form available; the next poll retries status only.
      }
    };
    const timer = window.setInterval(refreshRuntimeStatus, 15_000);
    return () => window.clearInterval(timer);
  }, [schedulePanelItemCode]);
  const selectedModeBoundFields = modeBoundFields(form.optimizationMode);
  const selectedRoutineMode = ROUTINE_OPTIMIZATION_MODES.find((option) => option.value === form.optimizationMode);
  const formUsesAutomaticCpc = isAutomaticRppOptimizationMode(form.optimizationMode);
  const availableOptimizationModes = ROUTINE_OPTIMIZATION_MODES;
  const activeEditLockMap = useMemo(() => new Map(activeEditLocks.map((row) => [row.itemCode, row])), [activeEditLocks]);
  const activeOperation = activeOperations[0] ?? null;

  async function refreshCollaboration() {
    try {
      const response = await fetch("/api/rpp/collaboration", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      setActiveEditLocks(Array.isArray(data.locks) ? data.locks : []);
      setActiveOperations(Array.isArray(data.activeOperations) ? data.activeOperations : []);
    } catch { /* 次回pollで再取得 */ }
  }

  useEffect(() => {
    const initial = window.setTimeout(() => { void refreshCollaboration(); }, 0);
    const timer = window.setInterval(() => { void refreshCollaboration(); }, 10_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!editSession) return;
    const heartbeat = async () => {
      try {
        const response = await fetch("/api/rpp/collaboration", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "heartbeat", itemCode: editSession.itemCode, token: editSession.token }),
        });
        if (!response.ok) {
          setError("編集ロックの有効期限が切れました。下書きは保存済みです。もう一度設定を開いてください。");
          setFormDrawerOpen(false);
          setEditSession(null);
        }
      } catch { /* 5分の猶予内で次回heartbeat */ }
    };
    const timer = window.setInterval(() => { void heartbeat(); }, 60_000);
    const releaseOnUnload = () => {
      void fetch("/api/rpp/collaboration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "release", itemCode: editSession.itemCode, token: editSession.token }),
        keepalive: true,
      });
    };
    window.addEventListener("beforeunload", releaseOnUnload);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("beforeunload", releaseOnUnload);
    };
  }, [editSession]);

  useEffect(() => {
    if (!formDrawerOpen || !editSession || !form.itemCode || !form.keyword) return;
    const timer = window.setTimeout(() => {
      localStorage.setItem(rppTargetDraftKey(form.itemCode, form.keyword), JSON.stringify(form));
      setDraftStatus("下書き保存済み");
    }, 500);
    return () => window.clearTimeout(timer);
  }, [editSession, form, formDrawerOpen]);


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
      mode: target?.optimizationMode || "FIXED",
      cpcKind: cfg.source === "商品CPC" ? "ITEM" : "KEYWORD",
      currentCpc,
      actualRoas: rec?.roas ?? (rec?.spend && rec.salesAmount != null ? (rec.salesAmount / rec.spend) * 100 : null),
      targetRoas: target?.effectiveRoasFloor ?? target?.roasFloor ?? 500,
      spend: rec?.spend ?? null,
      sales: rec?.salesAmount ?? null,
      positionSuggestedCpc: rec?.proposedCpc ?? null,
      fixedCpc: target?.fixedCpc ?? (target?.optimizationMode === "FIXED" || !target ? currentCpc : null),
      maxCpc: target?.maxCpc ?? null,
      roasMinCpc: target?.roasMinCpc ?? null,
      roasMaxCpc: target?.roasMaxCpc ?? null,
      positionMinCpc: target?.positionMinCpc ?? null,
      positionMaxCpc: target?.positionMaxCpc ?? null,
      balancedMinCpc: target?.balancedMinCpc ?? null,
      balancedMaxCpc: target?.balancedMaxCpc ?? null,
      changeLocked: target?.changeLocked,
      protectionType: target?.protectionType,
      experimentEndDate: target?.experimentEndDate,
      recommendationAction: rec?.action,
      recommendationBlocks: rec?.blocks,
      uploadReady: rec?.uploadReady,
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
    for (const owner of ownerNames) ensure(owner);
    return [...stats.values()].sort((a, b) => (a.owner === "担当未設定" ? -1 : b.owner === "担当未設定" ? 1 : a.owner.localeCompare(b.owner, "ja")));
  }, [configuredTargets, recommendationMap, targetMap, targets, positionSnapshotMap, ownerNames]);
  const exclusionRows = useMemo(() => baseExclusionProducts.map((row) => ({
    ...row,
    currentExcluded: exclusionOverrides[row.itemCode] ?? row.excluded,
  })), [baseExclusionProducts, exclusionOverrides]);
  const exclusionStateMap = useMemo(() => new Map(exclusionRows.map((row) => [row.itemCode, row])), [exclusionRows]);
  const filteredConfiguredTargets = configuredTargets.filter((cfg) => {
    const target = targetMap.get(cfg.id);
    const ownerOk = ownerFilter === "全て" || (target?.owner || cfg.owner || "担当未設定") === ownerFilter;
    const groupOk = groupFilter === "全て" || (target?.adGroup || "通常") === groupFilter;
    const query = tableSearch.trim().toLowerCase();
    const searchOk = !query || [cfg.itemCode, cfg.keyword, cfg.itemName, shortRppItemName(cfg.itemCode, cfg.itemName), target?.owner, target?.adGroup]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
    const preview = optimizationPreviewMap.get(cfg.id)?.preview;
    const position = recommendationMap.get(metricKey(cfg.itemCode, cfg.keyword))?.rppPosition || cfg.rppPosition || positionSnapshotMap.get(cfg.id)?.rppPosition || "未測定";
    const excluded = exclusionStateMap.get(cfg.itemCode)?.currentExcluded === true;
    const statusOk = tableStatusFilter === "ALL"
      || (tableStatusFilter === "CANDIDATE" && preview?.proposedCpc != null && preview.proposedCpc !== preview.currentCpc)
      || (tableStatusFilter === "ATTENTION" && (!target || /未測定|圏外|広告枠なし|測定エラー/.test(position)))
      || (tableStatusFilter === "EXCLUDED" && excluded);
    const modeOk = modeFilter === "ALL" || (target?.optimizationMode || "FIXED") === modeFilter;
    const protectionOk = protectionFilter === "ALL" || (target?.protectionType || "NORMAL") === protectionFilter;
    return ownerOk && groupOk && searchOk && statusOk && modeOk && protectionOk;
  });
  const exclusionChanged = exclusionRows.filter((row) => row.currentExcluded !== row.excluded);
  const excludedOwnerStats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of exclusionRows) {
      if (!row.excluded) continue;
      const owner = row.owner || "担当未設定";
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([owner, count]) => ({ owner, count }))
      .sort((a, b) => (a.owner === "担当未設定" ? -1 : b.owner === "担当未設定" ? 1 : a.owner.localeCompare(b.owner, "ja")));
  }, [exclusionRows]);
  const excludedProductsForOwner = exclusionRows.filter((row) => row.excluded && (ownerFilter === "全て" || (row.owner || "担当未設定") === ownerFilter));
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
    setDraftStatus("入力内容を保存中…");
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function openTargetForm(nextForm: FormState) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/rpp/collaboration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "acquire", itemCode: nextForm.itemCode }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok || !data.token) {
        const owner = data.lock?.actorName || "他の担当者";
        throw new Error(`🔒 ${owner}が ${nextForm.itemCode} を編集中です。完了後にもう一度開いてください。`);
      }
      const stored = parseRppTargetDraft<FormState>(localStorage.getItem(rppTargetDraftKey(nextForm.itemCode, nextForm.keyword)), nextForm.itemCode, nextForm.keyword);
      const restored = stored ?? nextForm;
      setForm(restored);
      setEditSession({ ...data.lock, token: data.token, draftKey: rppTargetDraftKey(nextForm.itemCode, nextForm.keyword) });
      setDraftStatus(stored ? "保存済みの下書きを復元しました" : "自動保存が有効です");
      setFormDrawerOpen(true);
      await refreshCollaboration();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function closeTargetForm(discardDraft = false) {
    const currentSession = editSession;
    if (discardDraft && form.itemCode && form.keyword) localStorage.removeItem(rppTargetDraftKey(form.itemCode, form.keyword));
    if (currentSession) {
      void fetch("/api/rpp/collaboration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "release", itemCode: currentSession.itemCode, token: currentSession.token }),
        keepalive: true,
      }).finally(() => { void refreshCollaboration(); });
    }
    setFormDrawerOpen(false);
    setEditSession(null);
    setDraftStatus(discardDraft ? "" : "下書き保存済み");
  }

  function excludedProductToForm(row: RppExclusionProduct): FormState {
    return { ...blank, itemCode: row.itemCode, keyword: "商品CPC", owner: row.owner ?? "", adGroup: "通常", searchKeywords: seoWordsForItem(row.itemCode)[0] ?? "", optimizationMode: "FIXED", fixedCpc: row.itemCpc == null ? "" : String(row.itemCpc) };
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

  function basisWordRows() {
    const rows = form.searchKeywords.split("\n");
    return rows.length ? rows : [""];
  }

  function updateBasisWord(index: number, value: string) {
    const rows = basisWordRows();
    rows[index] = value;
    patchForm("searchKeywords", rows.join("\n"));
  }

  function addBasisWordSlot() {
    patchForm("searchKeywords", [...basisWordRows(), ""].join("\n"));
  }

  function removeBasisWordSlot(index: number) {
    const rows = basisWordRows();
    if (rows.length === 1) {
      patchForm("searchKeywords", "");
      return;
    }
    patchForm("searchKeywords", rows.filter((_, rowIndex) => rowIndex !== index).join("\n"));
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

  async function toggleNightPause(itemCode: string) {
    const enabled = !nightPauseItemCodes.has(itemCode);
    setNightPauseBusyItemCode(itemCode);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/rpp/night-pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemCode, enabled }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "夜間停止設定の保存に失敗しました");
      setNightPauseItemCodes(new Set((Array.isArray(data.itemCodes) ? data.itemCodes : []).map((code: unknown) => String(code).trim().toLowerCase())));
      setMessage(`${itemCode} の夜間停止を${enabled ? "ON" : "OFF"}にしました（01:30 OFF / 06:00 ON）`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setNightPauseBusyItemCode(null);
    }
  }

  async function openSchedulePanel(itemCode: string) {
    setScheduleBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/rpp/delivery-schedules?itemCode=${encodeURIComponent(itemCode)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "時間指定の取得に失敗しました");
      const schedule = Array.isArray(data.schedules) ? data.schedules[0] : null;
      setScheduleRecurring(schedule?.recurring ?? blankRecurringSchedule);
      setScheduleUpdatedAt(schedule?.updatedAt ?? null);
      setScheduleStatus(Array.isArray(data.statuses) ? data.statuses.find((row: RppDeliveryScheduleStatus) => row.itemCode === itemCode) ?? null : null);
      setScheduleReservations(Array.isArray(data.reservations) ? data.reservations : []);
      setScheduleReservationAction("OFF");
      setScheduleReservationAt("");
      setSchedulePanelItemCode(itemCode);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setScheduleBusy(false);
    }
  }

  async function saveRecurringSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schedulePanelItemCode) return;
    setScheduleBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/rpp/delivery-schedules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemCode: schedulePanelItemCode, ...scheduleRecurring, expectedUpdatedAt: scheduleUpdatedAt }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "毎日停止時間の保存に失敗しました");
      setScheduleRecurring(data.schedule.recurring);
      setScheduleUpdatedAt(data.schedule.updatedAt);
      setMessage(`${schedulePanelItemCode} の毎日停止時間を保存しました。RMSはまだ変更していません。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setScheduleBusy(false);
    }
  }

  async function addScheduleReservation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schedulePanelItemCode) return;
    setScheduleBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/rpp/delivery-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemCode: schedulePanelItemCode, action: scheduleReservationAction, executeAt: scheduleReservationAt, timeZone: "Asia/Tokyo" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "日時予約の登録に失敗しました");
      setScheduleReservations((current) => [...current.filter((row) => row.id !== data.reservation.id), data.reservation].sort((a, b) => a.executeAt.localeCompare(b.executeAt)));
      setScheduleReservationAt("");
      setMessage(`${schedulePanelItemCode} の${scheduleReservationAction}予約を登録しました。RMSはまだ変更していません。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setScheduleBusy(false);
    }
  }

  async function cancelScheduleReservation(reservation: RppDeliveryReservation) {
    if (!schedulePanelItemCode) return;
    setScheduleBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/rpp/delivery-schedules", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservationId: reservation.id, itemCode: schedulePanelItemCode }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "予約取消に失敗しました");
      setScheduleReservations((current) => current.map((row) => row.id === data.reservation.id ? data.reservation : row));
      setMessage(`${schedulePanelItemCode} の予約を取り消しました。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setScheduleBusy(false);
    }
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
    if (activeOperation) {
      setError(`${activeOperation.actorName}がRMS反映処理中です。完了後に実行してください。`);
      return;
    }
    if (!window.confirm(`RMSへ除外ON/OFFを反映しますか？対象 ${exclusionChanged.length}商品。`)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const queuedJobIds: string[] = [];
    try {
      for (const row of exclusionChanged) {
        const res = await fetch("/api/rpp/apply-exclusion", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ execute: true, changes: [{ itemCode: row.itemCode, currentExcluded: row.currentExcluded, originalExcluded: row.excluded }] }),
        });
        const data = await res.json();
        if (!res.ok || !data.queued || !data.jobId) {
          const prefix = queuedJobIds.length ? `${queuedJobIds.length}商品は登録済みです。` : "";
          throw new Error(`${prefix}${row.itemCode}: ${data.error ?? "RMS反映ジョブの登録に失敗しました"}`);
        }
        queuedJobIds.push(data.jobId);
        setExclusionOverrides((current) => {
          const next = { ...current };
          delete next[row.itemCode];
          return next;
        });
      }
      setExclusionOverrides({});
      setMessage(`RMS反映ジョブを商品別に登録しました（${queuedJobIds.length}商品 / ${queuedJobIds.length}ジョブ）。Mac Studioワーカーが1商品ずつ反映・読戻し確認します。`);
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
      if (!editSession || editSession.itemCode !== form.itemCode.trim().toLowerCase()) throw new Error("編集ロックを取得し直してください");
      if (form.optimizationMode === "FIXED" && !form.fixedCpc.trim()) {
        throw new Error("CPC固定モードでは固定CPCが必須です");
      }
      const payload = {
        ...form,
        editLockToken: editSession.token,
        changeLocked: form.protectionType === "LOCKED",
        positionGoal: form.pcPositionGoal,
        searchKeywords: form.searchKeywords.split(/[\n,、]+/).map((kw) => kw.trim()).filter(Boolean),
        ctrGoal: Number(form.ctrGoal),
        cvrGoal: Number(form.cvrGoal),
        roasFloor: Number(form.roasFloor),
        fixedCpc: form.fixedCpc.trim() ? Number(form.fixedCpc) : null,
        maxCpc: form.maxCpc.trim() ? Number(form.maxCpc) : null,
        roasMinCpc: form.roasMinCpc.trim() ? Number(form.roasMinCpc) : null,
        roasMaxCpc: form.roasMaxCpc.trim() ? Number(form.roasMaxCpc) : null,
        positionMinCpc: form.positionMinCpc.trim() ? Number(form.positionMinCpc) : null,
        positionMaxCpc: form.positionMaxCpc.trim() ? Number(form.positionMaxCpc) : null,
        balancedMinCpc: form.balancedMinCpc.trim() ? Number(form.balancedMinCpc) : null,
        balancedMaxCpc: form.balancedMaxCpc.trim() ? Number(form.balancedMaxCpc) : null,
        experimentEndDate: "",
        experimentStartedAt: "",
        experimentBaseline: null,
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
      localStorage.removeItem(editSession.draftKey);
      setEditSession(null);
      setDraftStatus("");
      setForm(blank);
      setFormDrawerOpen(false);
      setMessage("保存しました");
      void refreshCollaboration();
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
      {activeOperation ? <p className="rpp-collaboration-banner operation"><b>RMS反映{activeOperation.status === "running" ? "中" : "待機中"}</b><span>{activeOperation.actorName} / {activeOperation.itemCodes.join(", ")}</span><small>完了・読戻し確認まで他の反映操作は待機してください。</small></p> : null}
      {activeEditLocks.length ? <p className="rpp-collaboration-banner"><b>編集中</b><span>{activeEditLocks.map((lock) => `${lock.actorName}：${lock.itemCode}`).join(" / ")}</span><small>別商品は同時に編集できます。</small></p> : null}
      {surface === "targets" ? <section className="owner-filter-strip" aria-label="担当・広告グループ絞り込み">
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
      </section> : <section className="owner-filter-strip excluded-owner-filter" aria-label="除外中商品の担当者絞り込み">
        <div className="owner-tabs">
          <button className={ownerFilter === "全て" ? "owner-tab active" : "owner-tab"} type="button" onClick={() => selectOwnerFilter("全て")}>全て<small>{exclusionRows.filter((row) => row.excluded).length}件</small></button>
          {excludedOwnerStats.map((row) => (
            <button className={ownerFilter === row.owner ? "owner-tab active" : "owner-tab"} key={row.owner} type="button" onClick={() => selectOwnerFilter(row.owner)}>
              {row.owner}<small>{row.count}件</small>
            </button>
          ))}
        </div>
      </section>}

      {surface === "targets" ? <section className="panel product-card-panel">
        <div className="section-heading">
          <div>
            <h2>{ownerFilter === "全て" ? "商品/KW別一覧" : `${ownerFilter}の商品/KW`}</h2>
            <p>担当タブ・広告グループに合わせて、この一覧だけが切り替わります。</p>
          </div>
          <div className="product-list-actions">
            <span className="status-pill status-hold">表示 {filteredConfiguredTargets.length}件</span>
            <span className={exclusionChanged.length ? "status-pill approval-held" : "status-pill status-approved"}>変更予定 {exclusionChanged.length}件</span>
            <button className="primary-button compact-button" disabled={!exclusionChanged.length || busy || Boolean(activeOperation)} type="button" onClick={applyExclusionToRms}>{activeOperation ? "RMS反映中" : "RMSへ反映"}</button>
            <button className="secondary-button compact-button" disabled={!exclusionChanged.length} type="button" onClick={downloadExcludeCsv}>手動CSV</button>
            <button className="secondary-button compact-button" disabled={!exclusionChanged.length} type="button" onClick={() => setExclusionOverrides({})}>変更を戻す</button>
            <small className="rms-upload-note">自動反映がRMSログインエラーになる場合は、手動CSVをRMS除外商品の一括アップロードへ入れてください。</small>
          </div>
        </div>
        <div className="adant-list-toolbar" aria-label="商品・キーワード絞り込み">
          <label className="adant-list-search">
            <span>検索</span>
            <input value={tableSearch} onChange={(event) => setTableSearch(event.target.value)} placeholder="商品番号・商品名・KW・担当" />
          </label>
          <div className="adant-status-filters">
            {([
              ["ALL", "すべて"],
              ["CANDIDATE", `CPC候補 ${actionableOptimizationPreviews.length}`],
              ["ATTENTION", "要確認"],
              ["EXCLUDED", "除外中"],
            ] as const).map(([value, label]) => (
              <button className={tableStatusFilter === value ? "active" : ""} key={value} type="button" onClick={() => setTableStatusFilter(value)}>{label}</button>
            ))}
          </div>
          <label className="compact-select"><RppInfoTip label="モード" /><select value={modeFilter} onChange={(event) => setModeFilter(event.target.value as "ALL" | RppOptimizationMode)}><option value="ALL">すべて</option>{ROUTINE_OPTIMIZATION_MODES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label className="compact-select"><RppInfoTip label="保護" /><select value={protectionFilter} onChange={(event) => setProtectionFilter(event.target.value as "ALL" | RppProtectionType)}><option value="ALL">すべて</option><option value="NORMAL">通常</option><option value="BLOCK">ブロック</option><option value="WHITELIST">ホワイト</option><option value="LOCKED">変更不可</option><option value="FOCUS">注力</option></select></label>
          <button className="filter-clear" type="button" onClick={() => { setTableSearch(""); setTableStatusFilter("ALL"); setModeFilter("ALL"); setProtectionFilter("ALL"); setOwnerFilter("全て"); setGroupFilter("全て"); }}>条件クリア</button>
          <small>表示 {filteredConfiguredTargets.length} / {configuredTargets.length}件</small>
          <small>実績対象 {performanceDateRange || "未取得"}</small>
        </div>
        <div className="optimization-preview-bar">
          <div className="optimization-preview-main">
            <div className="optimization-preview-title">
              <div><b>最適化プレビュー</b><small>実績を分析し、ルールで判断してから提案します。RMSには自動反映しません。</small></div>
              <div className="optimization-flow" aria-label="最適化フロー"><span>分析</span><i>→</i><span>判断</span><i>→</i><span>提案</span></div>
            </div>
            <div className="optimization-summary-grid">
              <span><small><RppInfoTip label="候補" /></small><strong>{actionableOptimizationPreviews.length}件</strong></span>
              <span><small><RppInfoTip label="選択" /></small><strong>{selectedOptimizationPreviews.length}件</strong></span>
              <span><small><RppInfoTip label="予測広告費" /></small><strong>{yenNumber(selectedProjectedSpend)}</strong></span>
              <span className={selectedSavings >= 0 ? "saving-positive" : "saving-negative"}><small><RppInfoTip label="削減見込み" /></small><strong>{yenNumber(selectedSavings)}</strong></span>
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
                <th className="select-col"><RppInfoTip label="選択" /></th>
                <th className="product-col"><RppInfoTip label="商品 / キーワード" /></th>
                <th><RppInfoTip label="担当 / G" /></th>
                <th><RppInfoTip label="実績" /></th>
                <th><RppInfoTip label="CPC" /></th>
                <th><RppInfoTip label="ROAS" /></th>
                <th><RppInfoTip label="検索順位" /></th>
                <th><RppInfoTip label="運用モード" /></th>
                <th><RppInfoTip label="保護" /></th>
                <th><RppInfoTip label="配信" /></th>
                <th className="actions-col"><RppInfoTip label="操作" /></th>
              </tr>
            </thead>
            <tbody>
              {filteredConfiguredTargets.map((cfg) => {
                const row = targetMap.get(cfg.id);
                const rec = recommendationMap.get(metricKey(cfg.itemCode, cfg.keyword));
                const snapshot = positionSnapshotMap.get(cfg.id);
                const position = rec?.rppPosition || cfg.rppPosition || snapshot?.rppPosition || "未測定";
                const positionKeyword = row?.searchKeywords?.[0] || representativeKeyword(cfg, snapshot);
                const exclusionState = exclusionStateMap.get(cfg.itemCode);
                const currentExcluded = exclusionState?.currentExcluded ?? false;
                const productExclusionOperable = canOperateProductExclusion(cfg.source);
                const exclusionChangedForItem = exclusionState ? currentExcluded !== exclusionState.excluded : false;
                const canUndoAccidentalExclusion = Boolean(exclusionState && exclusionState.excluded === false && currentExcluded === true);
                const itemTargetCompletion = itemTargetCompletionMap.get(cfg.itemCode) ?? { total: 1, saved: row ? 1 : 0, missing: row ? 0 : 1 };
                const canReleaseExclusion = itemTargetCompletion.total > 0 && itemTargetCompletion.missing === 0;
                const roas = rec?.roas ?? (rec?.spend && rec.salesAmount != null ? Math.round((rec.salesAmount / rec.spend) * 100) : null);
                const optimization = optimizationPreviewMap.get(cfg.id)?.preview;
                const optimizationActionable = optimization?.proposedCpc != null && optimization.proposedCpc !== optimization.currentCpc;
                const positions = positionParts(position);
                const protectionLabel = row?.protectionType && row.protectionType !== "NORMAL"
                  ? ({ BLOCK: "ブロック", WHITELIST: "ホワイト", LOCKED: "変更不可", FOCUS: "注力" }[row.protectionType])
                  : "通常";
                const effectiveMode = row?.optimizationMode || "FIXED";
                const effectiveFixedCpc = row?.fixedCpc ?? (effectiveMode === "FIXED" ? configuredCurrentCpc(cfg) : null);
                const nightPauseEnabled = nightPauseItemCodes.has(cfg.itemCode);
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
                      <small title={cfg.itemName}>{shortRppItemName(cfg.itemCode, cfg.itemName)}</small>
                    </td>
                    <td><b>{row?.owner || cfg.owner || "未設定"}</b><small>{row?.adGroup || "通常"}</small></td>
                    <td className="number-cell"><b>{formatRppYen(rec?.spend)}</b><small>{formatRppClicks(rec?.clicks)} / 売上 {formatRppYen(rec?.salesAmount)}</small></td>
                    <td className="cpc-cell">
                      <b>{optimization?.currentCpc ? `${optimization.currentCpc}円` : cfg.source === "商品CPC" ? yen(cfg.itemCpc) : yen(cfg.keywordCpc)}</b>
                      <span className={optimization?.delta == null ? "" : optimization.delta > 0 ? "cpc-up" : optimization.delta < 0 ? "cpc-down" : ""}>→ {optimization?.proposedCpc == null ? "提案なし" : `${optimization.proposedCpc}円`}</span>
                      <small>{optimization?.savings == null ? "" : `効果 ${yenNumber(optimization.savings)}`}</small>
                    </td>
                    <td className="number-cell"><b>{roas == null ? "-" : `${Math.round(roas)}%`}</b><small>→ {optimization?.projectedRoas == null ? "-" : `${Math.round(optimization.projectedRoas)}%`}</small></td>
                    <td className="rank-cell" title={positionKeyword || undefined}>{positions.map((part) => <span key={`${part.device}-${part.status}`}><b>{part.device}</b><em>{part.status}</em></span>)}</td>
                    <td><span className={`optimization-mode-pill mode-${effectiveMode.toLowerCase()}`}>{optimizationModeLabel(effectiveMode)}</span><small>{effectiveMode === "FIXED" ? `固定 ${yen(effectiveFixedCpc)}` : `目標 ${row?.roasFloor ?? 500}%`}</small></td>
                    <td><span className={`protection-pill protection-${(row?.protectionType || "NORMAL").toLowerCase()}`}>{protectionLabel}</span><small>{row?.lockReason || ""}</small></td>
                    <td><span className={`delivery-dot ${currentExcluded ? "off" : "on"}`}><i />{deliveryLabel(cfg.source, currentExcluded)}</span>{exclusionChangedForItem ? <small className="pending-change">変更予定</small> : null}</td>
                    <td className="actions-col">
                      <button disabled={busy} type="button" onClick={() => openTargetForm(row ? toForm(row, cfg) : configuredToForm(cfg))} title={activeEditLockMap.get(cfg.itemCode) ? `${activeEditLockMap.get(cfg.itemCode)?.actorName}が編集中` : undefined}>{activeEditLockMap.get(cfg.itemCode) ? "🔒 設定" : "設定"}</button>
                      {canDownloadManualCpcCsv(effectiveMode)
                        ? <button disabled={busy || row?.changeLocked === true || row?.protectionType === "BLOCK"} type="button" onClick={() => downloadCpcCsv(cfg)} title={row?.changeLocked || row?.protectionType === "BLOCK" ? "変更対象外です" : "RMS手動アップロード用のCPC変更CSVを出力します"}>CPC変更CSV</button>
                        : <span className="keyword-exclusion-na" title="設定したルールに従って自動調整します">自動管理</span>}
                      {productExclusionOperable ? <button className={currentExcluded ? "restore-button" : "danger-ghost"} disabled={busy || (currentExcluded && !canReleaseExclusion && !canUndoAccidentalExclusion)} type="button" onClick={() => toggleExcluded(cfg.itemCode, canReleaseExclusion)} title={currentExcluded && !canReleaseExclusion && !canUndoAccidentalExclusion ? "この商品に目標が1つ以上入るまで除外解除できません" : undefined}>{exclusionChangedForItem ? "戻す" : currentExcluded ? "再開" : "除外"}</button> : <span className="keyword-exclusion-na" title="広告除外は商品CPC行から操作します">商品単位</span>}
                      {productExclusionOperable ? <button className="schedule-button" disabled={busy || scheduleBusy} type="button" onClick={() => openSchedulePanel(cfg.itemCode)}>時間指定</button> : null}
                      {productExclusionOperable ? <div className="night-pause-control"><RppInfoTip label="夜間停止" /><button className={nightPauseEnabled ? "restore-button" : ""} disabled={busy || nightPauseBusyItemCode !== null} type="button" aria-pressed={nightPauseEnabled} onClick={() => toggleNightPause(cfg.itemCode)}>{nightPauseBusyItemCode === cfg.itemCode ? "保存中…" : `夜間停止 ${nightPauseEnabled ? "ON" : "OFF"}`}</button><small>01:30 OFF / 06:00 ON</small></div> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!filteredConfiguredTargets.length ? <p>この担当のRPP設定中商品/KWはありません。</p> : null}
        </div>
      </section> : <section className="panel excluded-product-block excluded-product-page" id="rpp-excluded">
        <div className="section-heading">
          <div>
            <h2>{ownerFilter === "全て" ? "除外中商品（広告ON戻し）" : `${ownerFilter}の除外中商品`}</h2>
            <p>担当者タブで切り替えます。目標設定後に広告ONへ戻し、RMS反映で確定します。</p>
          </div>
          <div className="product-list-actions">
            <span className="status-pill status-hold">表示 {excludedProductsForOwner.length}件</span>
            <span className={exclusionChanged.length ? "status-pill approval-held" : "status-pill status-approved"}>変更予定 {exclusionChanged.length}件</span>
            <button className="primary-button compact-button" disabled={!exclusionChanged.length || busy || Boolean(activeOperation)} type="button" onClick={applyExclusionToRms}>{activeOperation ? "RMS反映中" : "RMSへ反映"}</button>
            <button className="secondary-button compact-button" disabled={!exclusionChanged.length} type="button" onClick={downloadExcludeCsv}>手動CSV</button>
            <button className="secondary-button compact-button" disabled={!exclusionChanged.length} type="button" onClick={() => setExclusionOverrides({})}>変更を戻す</button>
          </div>
        </div>
        <div className="excluded-product-grid">
          {excludedProductsForOwner.map((row) => {
            const completion = itemTargetCompletionMap.get(row.itemCode) ?? { total: 0, saved: savedTargetCountByItemCode.get(row.itemCode) ?? 0, missing: 0 };
            const savedCount = completion.saved;
            const canTurnOn = completion.total > 0 && completion.missing === 0;
            const changed = row.currentExcluded !== row.excluded;
            return (
              <article className="excluded-product-row" key={row.itemCode}>
                <div><b>{row.itemCode}</b><br /><small title={row.itemName}>{shortRppItemName(row.itemCode, row.itemName)}</small><br /><small>{row.owner || "担当未設定"}</small></div>
                <span><small>商品CPC</small><strong>{yen(row.itemCpc)}</strong></span>
                <span><small>保存目標</small><strong>{savedCount}件</strong></span>
                <div className="card-actions excluded-actions">
                  <button disabled={busy || !canTurnOn} type="button" onClick={() => toggleExcluded(row.itemCode, canTurnOn)} title={!canTurnOn ? "先に目標設定を1つ作成してください" : undefined}>{changed ? "元に戻す" : "広告ONに戻す"}</button>
                  <button disabled={busy} type="button" onClick={() => openTargetForm(excludedProductToForm(row))} title={activeEditLockMap.get(row.itemCode) ? `${activeEditLockMap.get(row.itemCode)?.actorName}が編集中` : undefined}>{activeEditLockMap.get(row.itemCode) ? "🔒 目標設定" : "目標設定"}</button>
                  <button className="schedule-button" disabled={busy || scheduleBusy} type="button" onClick={() => openSchedulePanel(row.itemCode)}>時間指定</button>
                </div>
              </article>
            );
          })}
          {!excludedProductsForOwner.length ? <p>この担当者の除外中商品はありません。</p> : null}
        </div>
      </section>}

      {surface === "targets" ? <section className="panel experiment-history-panel" id="rpp-experiments">
        <div className="section-heading compact-heading">
          <div><h2>実験トラッキング</h2><p>過去に保存された実験履歴を、終了時の同じ指標と比較します。</p></div>
          <div className="experiment-summary">
            <span>実験中 <b>{experiments.filter((row) => row.status === "ACTIVE").length}</b></span>
            <span>終了実績待ち <b>{experiments.filter((row) => row.status === "EXPIRED").length}</b></span>
            <span>終了 <b>{experiments.filter((row) => row.status === "COMPLETED").length}</b></span>
          </div>
        </div>
        {experiments.length ? (
          <div className="experiment-table-wrap">
            <table className="experiment-table">
              <thead><tr><th><RppInfoTip label="商品 / KW" /></th><th><RppInfoTip label="モード・期間" /></th><th><RppInfoTip label="開始値" /></th><th><RppInfoTip label="終了値" /></th><th><RppInfoTip label="状態" /></th><th><RppInfoTip label="操作" /></th></tr></thead>
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
        ) : <p className="experiment-empty">保存済みの実験履歴はありません。現在の4つの通常運用モードでは実験履歴を作成しません。</p>}
      </section> : null}

      {schedulePanelItemCode ? <button className="rpp-drawer-backdrop" aria-label="時間指定を閉じる" type="button" onClick={() => setSchedulePanelItemCode(null)} /> : null}
      {schedulePanelItemCode ? <aside className="rpp-schedule-drawer open" role="dialog" aria-modal="true" aria-labelledby="rpp-schedule-title">
        <div className="rpp-drawer-head">
          <div><small>PRODUCT DELIVERY SCHEDULE</small><h2 id="rpp-schedule-title">{schedulePanelItemCode} の時間指定</h2><p>時刻はすべて日本時間（JST）です。</p></div>
          <button type="button" aria-label="閉じる" onClick={() => setSchedulePanelItemCode(null)}>×</button>
        </div>
        <div className="rpp-schedule-body">
          {scheduleStatus ? <div className="rpp-schedule-runtime-status" aria-live="polite">
            <span>時間帯判定 <b>{scheduleStatus.recurringActive ? "停止時間内" : "停止時間外"}</b></span>
            <span>実行中 <b>{scheduleStatus.running}件</b></span>
            <span>待ち <b>{scheduleStatus.backlog}件</b></span>
            <span>次回 <b>{scheduleStatus.nextTransition ? `${scheduleStatus.nextTransition.action} ${new Date(scheduleStatus.nextTransition.at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "なし"}</b></span>
          </div> : null}
          <form className="rpp-schedule-section" onSubmit={saveRecurringSchedule}>
            <div><h3>毎日停止</h3><p>毎日、指定した開始時刻に広告OFF、終了時刻に広告ONへ戻します。日付をまたぐ指定もできます。</p></div>
            <label className="rpp-schedule-enabled"><input autoFocus type="checkbox" checked={scheduleRecurring.enabled} onChange={(event) => setScheduleRecurring((current) => ({ ...current, enabled: event.target.checked }))} />この時間帯停止を使う</label>
            <div className="rpp-schedule-time-row">
              <label>広告OFF<input required type="time" value={scheduleRecurring.startTime} onChange={(event) => setScheduleRecurring((current) => ({ ...current, startTime: event.target.value }))} /></label>
              <span>→</span>
              <label>広告ON<input required type="time" value={scheduleRecurring.endTime} onChange={(event) => setScheduleRecurring((current) => ({ ...current, endTime: event.target.value }))} /></label>
            </div>
            <button className="primary-button" disabled={scheduleBusy} type="submit">毎日停止を保存</button>
          </form>

          <form className="rpp-schedule-section" onSubmit={addScheduleReservation}>
            <div><h3>1回限りのON/OFF予約</h3><p>時間帯ではなく、指定日時に1回だけ広告ONまたは広告OFFを実行します。</p></div>
            <div className="rpp-schedule-reservation-row">
              <label>動作<select value={scheduleReservationAction} onChange={(event) => setScheduleReservationAction(event.target.value as "ON" | "OFF")}><option value="OFF">広告OFF</option><option value="ON">広告ON</option></select></label>
              <label>実行日時（JST）<input required type="datetime-local" value={scheduleReservationAt} onChange={(event) => setScheduleReservationAt(event.target.value)} /></label>
            </div>
            <button className="primary-button" disabled={scheduleBusy || !scheduleReservationAt} type="submit">予約を追加</button>
            <small className="rpp-schedule-safe-note">予約の登録だけではRMSの配信状態は変わりません。指定時刻以降に商品単位で順次反映し、読戻し確認します。</small>
          </form>

          <section className="rpp-schedule-section">
            <div><h3>予約一覧</h3><p>保留中の予約は実行前に取り消せます。</p></div>
            <div className="rpp-schedule-reservations">
              {scheduleReservations.length ? scheduleReservations.map((reservation) => (
                <article key={reservation.id}>
                  <div><b>{reservation.action === "ON" ? "広告ON" : "広告OFF"}</b><span>{new Date(reservation.executeAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} JST</span></div>
                  <small>{reservation.status === "RUNNING" ? "実行中（取消不可）" : reservation.status === "PENDING" ? "実行待ち" : reservation.status === "SUCCEEDED" ? "実行済み" : reservation.status === "FAILED" ? `失敗：${reservation.error || "詳細なし"}` : "取消済み"}</small>
                  {reservation.status === "PENDING" ? <button disabled={scheduleBusy} type="button" onClick={() => cancelScheduleReservation(reservation)}>取消</button> : null}
                </article>
              )) : <p>予約はありません。</p>}
            </div>
          </section>
        </div>
      </aside> : null}

      {formDrawerOpen ? <button className="rpp-drawer-backdrop" aria-label="設定を閉じる" type="button" onClick={() => closeTargetForm()} /> : null}
      <aside className={formDrawerOpen ? "rpp-target-drawer open" : "rpp-target-drawer"} id="rpp-target-form" aria-hidden={!formDrawerOpen}>
        <div className="rpp-drawer-head"><div><small>ROW SETTINGS</small><h2>{form.itemCode || "商品/KW"} の運用設定</h2><p>{form.keyword || "一覧の設定ボタンから対象を選択"}</p><span className="draft-status">🔒 編集中 / {draftStatus}</span></div><button type="button" aria-label="閉じる" onClick={() => closeTargetForm()}>×</button></div>
        <div className="rpp-drawer-body">
        <form className="target-form" onSubmit={saveTarget}>
          <div className="form-row two-cols">
            <label><RppInfoTip label="商品管理番号" /><input value={form.itemCode} onChange={(e) => patchForm("itemCode", e.target.value)} placeholder="r0606" required disabled={Boolean(editSession)} /></label>
            <label><RppInfoTip label="RPP設定KW" /><input value={form.keyword} onChange={(e) => patchForm("keyword", e.target.value)} placeholder="まな板 / 商品CPC" required disabled={Boolean(editSession)} /></label>
          </div>
          <div className="target-form-field">
            <span><RppInfoTip label="基準ワード" />（複数可・1語以上必須）</span>
            <div className="keyword-candidate-box">
              <b>基準ワード候補</b>
              <div className="search-word-chips">
                {searchWordOptions.length ? searchWordOptions.map((word) => <button type="button" key={word} onClick={() => addSearchWord(word)}>＋ {word}</button>) : <small>候補なし。直接入力できます。</small>}
              </div>
            </div>
            <div className="basis-word-list">
              {basisWordRows().map((word, index) => (
                <div className="basis-word-row" key={`basis-word-${index}`}>
                  <input
                    required={form.keyword === "商品CPC" && index === 0}
                    value={word}
                    onChange={(event) => updateBasisWord(index, event.target.value)}
                    placeholder={`基準ワード ${index + 1}`}
                  />
                  <button type="button" onClick={() => removeBasisWordSlot(index)} aria-label={`基準ワード${index + 1}を削除`}>削除</button>
                </div>
              ))}
              <button className="basis-word-add" type="button" onClick={addBasisWordSlot}>＋ 基準ワードを追加</button>
            </div>
            <small>入力枠は追加・削除できます。登録した基準ワードのどれか1つでもPC・SPの目標順位を満たせば達成扱いです。</small>
          </div>
          <div className="form-row two-cols">
            <label><RppInfoTip label="担当" /><input value={form.owner} onChange={(e) => patchForm("owner", e.target.value)} placeholder="森下" /></label>
            <label><RppInfoTip label="広告グループ" /><input list="rpp-ad-groups" value={form.adGroup} onChange={(e) => patchForm("adGroup", e.target.value)} placeholder="通常 / 注力 / 季節 / 利益重視" /></label>
            <datalist id="rpp-ad-groups">{adGroups.filter((g) => g !== "全て").map((g) => <option key={g} value={g} />)}</datalist>
          </div>
          <div className="form-row two-cols">
            <label><RppInfoTip label="保護区分" />
              <select value={form.protectionType} onChange={(e) => patchForm("protectionType", e.target.value as RppProtectionType)}>
                <option value="NORMAL">通常</option>
                <option value="BLOCK">ブロック（完全対象外）</option>
                <option value="WHITELIST">ホワイト（除外判定から保護）</option>
                <option value="LOCKED">変更不可（CPC固定）</option>
                <option value="FOCUS">注力（上限内で積極運用）</option>
              </select>
            </label>
            <label><RppInfoTip label="保護理由" /><input value={form.lockReason} onChange={(e) => patchForm("lockReason", e.target.value)} placeholder="セール中 / 戦略商品 / 要確認" disabled={form.protectionType === "NORMAL"} /></label>
          </div>
          <div className="form-row two-cols">
            <label><RppInfoTip label="運用方針" />
              <select value={form.policy} onChange={(e) => patchForm("policy", e.target.value as RppOperationPolicy)}>
                <option value="攻め">攻め</option>
                <option value="維持">維持</option>
                <option value="テスト">テスト</option>
                <option value="停止候補">停止候補</option>
              </select>
            </label>
          </div>
          <div className="optimization-mode-selector">
            <span><RppInfoTip label="最適化モード" /></span>
            <div className="optimization-mode-options" aria-label="通常運用モード">
              {availableOptimizationModes.map((option) => <button className={form.optimizationMode === option.value ? `active mode-${option.value.toLowerCase()}` : `mode-${option.value.toLowerCase()}`} key={option.value} type="button" onClick={() => patchForm("optimizationMode", option.value)}><b>{option.label}</b><small>{option.description}</small></button>)}
            </div>
            <small>{formUsesAutomaticCpc ? "選択したモードに従って自動調整します。" : "固定CPCを維持し、自動調整は行いません。"}</small>
          </div>
          {selectedModeBoundFields && selectedRoutineMode ? <div className="form-row two-cols optimization-mode-fields">
            <label><RppInfoTip label="モード別CPC下限" /><input type="number" min="1" step="1" value={form[selectedModeBoundFields.minimum]} onChange={(e) => patchForm(selectedModeBoundFields.minimum, e.target.value)} placeholder="未設定なら楽天下限" /><small>{selectedRoutineMode.label}専用。楽天下限（商品20円 / KW40円）が優先されます。</small></label>
            <label><RppInfoTip label="モード別CPC上限" /><input type="number" min="1" step="1" value={form[selectedModeBoundFields.maximum]} onChange={(e) => patchForm(selectedModeBoundFields.maximum, e.target.value)} placeholder={form.maxCpc ? `旧上限 ${form.maxCpc}円を適用中` : "未設定なら安全幅のみ"} /><small>{selectedRoutineMode.label}専用。未設定時は既存の旧上限を引き継ぎます。</small></label>
          </div> : <div className="form-row optimization-mode-fields">
            <label><RppInfoTip label="固定CPC" /><input type="number" min="1" step="1" value={form.fixedCpc} onChange={(e) => patchForm("fixedCpc", e.target.value)} placeholder="例 50" /><small>CPC固定モード専用。RMSへ直接登録する場合と同じ指定額を維持します。</small></label>
          </div>}
          <div className="form-row five-cols">
            <label><RppInfoTip label="CTR目標" /><input type="number" min="0" step="0.1" value={form.ctrGoal} onChange={(e) => patchForm("ctrGoal", e.target.value)} /></label>
            <label><RppInfoTip label="CVR目標" /><input type="number" min="0" step="0.1" value={form.cvrGoal} onChange={(e) => patchForm("cvrGoal", e.target.value)} /></label>
            <label><RppInfoTip label="目標ROAS" /><input type="number" min="0" step="10" value={form.roasFloor} onChange={(e) => patchForm("roasFloor", e.target.value)} /></label>
            <label><RppInfoTip label="PC検索位置目標" />
              <select value={form.pcPositionGoal} onChange={(e) => patchForm("pcPositionGoal", e.target.value as RppPositionGoal)}>
                {PC_POSITION_GOAL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label><RppInfoTip label="SP検索位置目標" />
              <select value={form.spPositionGoal} onChange={(e) => patchForm("spPositionGoal", e.target.value as RppPositionGoal)}>
                {POSITION_GOAL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          </div>
          <label><RppInfoTip label="メモ" /><textarea value={form.note} onChange={(e) => patchForm("note", e.target.value)} placeholder="通常検索が強い場合はRPPは1ページ目内でOK、など" /></label>
          <div className="inline-links form-actions">
            <button className="primary-button" disabled={busy} type="submit">目標を保存</button>
            <button className="secondary-button" disabled={busy} type="button" onClick={() => closeTargetForm()}>閉じる</button>
            <button className="secondary-button" disabled={busy || missingCount === 0 || activeEditLocks.length > 0 || Boolean(activeOperation)} type="button" onClick={seedMissingTargets}>未設定を一括作成</button>
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
            <li><b>ROASモード</b><small>目標ROASに近づくようCPCを逆算する通常運用です。</small></li>
            <li><b>検索順位モード</b><small>既存のPC/SP検索順位提案を方向シグナルとして使う通常運用です。</small></li>
            <li><b>バランスモード</b><small>ROASを採算ゲートにし、検索順位提案と組み合わせます。未達時は低い候補を選び、達成時の引き上げもROAS候補までに制限します。</small></li>
            <li><b>モード別CPC範囲</b><small>ROAS・検索順位・バランスは各モードの下限・上限を保存します。商品20円・KW40円の楽天下限と1回の安全幅は常に優先されます。</small></li>
            <li><b>CPC固定モード</b><small>指定CPCを維持して自動調整を止めます。変更時は一覧の「CPC変更CSV」を使います。</small></li>
          </ul>
        </div>
        </div>
      </aside>

    </div>
  );
}
