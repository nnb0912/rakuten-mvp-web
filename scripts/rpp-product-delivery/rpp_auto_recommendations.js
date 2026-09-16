#!/usr/bin/env node
/**
 * RPP広告運用 自動提案 Phase 1
 * ============================================================
 * 既存CSV/順位ログから「上げ候補・下げ候補・保留」を生成する。
 * 本番変更なし。RMSアップロードもしない。
 *
 * 出力:
 *   rpp_recommendations/rpp_auto_recommendations_YYYYMMDD.json
 *   rpp_recommendations/rpp_auto_recommendations_YYYYMMDD.csv
 *   --out=... 指定時は朝通知用テキストも書き出す。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const iconv = require('iconv-lite');
const { analyze, loadSettings, loadItemSettings, loadPerformance, loadItemPerformance, buildProductCpcPerformance } = require('./rpp_cpc_advisor');
const { loadExcludeSet } = require('./rpp_ad_status_report');
const { latestPositionMap } = require('./rpp_position_data');
const { displayName } = require('./rpp_display_names');
const { emit } = require('./rpp_notify_out');
const { dataFreshness } = require('./rpp_data_guards');

const PROJECT = path.resolve(process.env.RPP_PROJECT_DIR || __dirname);
const DEFAULT_AUTO_SETTINGS = {
  enabled: false,
  itemEnabledDefault: false,
  keywordEnabledDefault: true,
  floorCpc: 40,
  itemCpcMax: 120,
  keywordCpcMax: 120,
  maxRaisePerDay: 20,
  maxLowerPerDay: 10,
  roasFloor: 500,
  onlyRaiseWhenPageOut: true,
  excludeChangeLocked: true,
  excludeRmsExcluded: true,
};
const PC_FIRST_PAGE_RPP = 5;
const SP_FIRST_PAGE_RPP = 7;

function arg(name, def = null) {
  const p = process.argv.find(a => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : def;
}

function todayStamp() {
  return new Date().toLocaleDateString('sv-SE').replace(/-/g, '');
}

function loadRoasBar() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(PROJECT, 'rpp_alert_config.json'), 'utf8'));
    return Number(c.rules?.roas?.['ROASがこの%未満なら候補'] ?? 500);
  } catch (_) {
    return 500;
  }
}

function boolValue(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
  }
  return fallback;
}

function numValue(value, fallback, min = 0) {
  if (value == null || String(value).trim() === '') return fallback;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) && n >= min ? Math.round(n) : fallback;
}

function loadAutoSettings(filePath = path.join(PROJECT, 'rpp_targets', 'rpp_auto_adjustment_settings.json')) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
  return {
    enabled: boolValue(raw.enabled, DEFAULT_AUTO_SETTINGS.enabled),
    itemEnabledDefault: boolValue(raw.itemEnabledDefault, DEFAULT_AUTO_SETTINGS.itemEnabledDefault),
    keywordEnabledDefault: boolValue(raw.keywordEnabledDefault, DEFAULT_AUTO_SETTINGS.keywordEnabledDefault),
    floorCpc: numValue(raw.floorCpc, DEFAULT_AUTO_SETTINGS.floorCpc, 1),
    itemCpcMax: numValue(raw.itemCpcMax, DEFAULT_AUTO_SETTINGS.itemCpcMax, 1),
    keywordCpcMax: numValue(raw.keywordCpcMax, DEFAULT_AUTO_SETTINGS.keywordCpcMax, 1),
    maxRaisePerDay: numValue(raw.maxRaisePerDay, DEFAULT_AUTO_SETTINGS.maxRaisePerDay, 0),
    maxLowerPerDay: numValue(raw.maxLowerPerDay, DEFAULT_AUTO_SETTINGS.maxLowerPerDay, 0),
    roasFloor: numValue(raw.roasFloor, loadRoasBar(), 0),
    onlyRaiseWhenPageOut: boolValue(raw.onlyRaiseWhenPageOut, DEFAULT_AUTO_SETTINGS.onlyRaiseWhenPageOut),
    excludeChangeLocked: boolValue(raw.excludeChangeLocked, DEFAULT_AUTO_SETTINGS.excludeChangeLocked),
    excludeRmsExcluded: boolValue(raw.excludeRmsExcluded, DEFAULT_AUTO_SETTINGS.excludeRmsExcluded),
    updatedAt: raw.updatedAt || null,
  };
}

function safeNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}


function loadTargetProfiles(filePath = path.join(PROJECT, 'rpp_targets', 'rpp_alert_targets.json')) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rows = Array.isArray(raw) ? raw : (raw.targets || []);
    const profiles = new Map();
    for (const row of rows) {
      const itemCode = String(row.itemCode || '').trim().toLowerCase();
      const keyword = String(row.keyword || '').trim();
      if (!itemCode || !keyword) continue;
      const protectionType = ['BLOCK', 'WHITELIST', 'LOCKED', 'FOCUS'].includes(row.protectionType)
        ? row.protectionType
        : row.changeLocked ? 'LOCKED' : 'NORMAL';
      profiles.set(`${itemCode}	${keyword}`, {
        ...row,
        itemCode,
        keyword,
        optimizationMode: ['ROAS', 'POSITION', 'BALANCED', 'FIXED'].includes(row.optimizationMode) ? row.optimizationMode : 'ROAS',
        protectionType,
      });
    }
    return profiles;
  } catch (_) {
    return new Map();
  }
}

function profileModeBounds(profile) {
  if (profile.optimizationMode === 'ROAS') return { minimum: profile.roasMinCpc, maximum: profile.roasMaxCpc };
  if (profile.optimizationMode === 'POSITION') return { minimum: profile.positionMinCpc, maximum: profile.positionMaxCpc };
  if (profile.optimizationMode === 'BALANCED') return { minimum: profile.balancedMinCpc, maximum: profile.balancedMaxCpc };
  return { minimum: null, maximum: null };
}

function clampProfileCpc(value, current, row, profile, autoSettings) {
  const floor = row.source === '商品CPC' ? 20 : Math.max(40, autoSettings.floorCpc);
  const maxRate = profile.protectionType === 'FOCUS' ? 1.5 : 1.2;
  const bounds = profileModeBounds(profile);
  const configuredMin = safeNum(bounds.minimum, 0) > 0 ? safeNum(bounds.minimum) : floor;
  const dailyMinimum = current - Math.max(0, safeNum(autoSettings.maxLowerPerDay, DEFAULT_AUTO_SETTINGS.maxLowerPerDay));
  const dailyMaximum = current + Math.max(0, safeNum(autoSettings.maxRaisePerDay, DEFAULT_AUTO_SETTINGS.maxRaisePerDay));
  const safetyMin = Math.max(floor, current * 0.5, configuredMin, dailyMinimum);
  const safetyMax = Math.min(current * maxRate, dailyMaximum);
  const configuredMaxRaw = safeNum(bounds.maximum, 0) > 0
    ? safeNum(bounds.maximum)
    : safeNum(profile.maxCpc, 0) > 0 ? safeNum(profile.maxCpc) : cpcCapFor(row, autoSettings);
  const configuredMax = configuredMaxRaw;
  return Math.max(floor, Math.round(Math.min(Math.max(value, safetyMin), safetyMax, configuredMax)));
}

function classifyProfile(row, posState, profile, autoSettings) {
  const protection = profile.protectionType || 'NORMAL';
  if (protection === 'BLOCK') return { action: 'HOLD', proposedCpc: null, reasons: ['ブロック対象'], blocks: [profile.lockReason || '完全対象外'] };
  if (protection === 'LOCKED' || profile.changeLocked) return { action: 'HOLD', proposedCpc: null, reasons: ['変更不可リスト対象'], blocks: [profile.lockReason || 'CPC固定'] };
  let raw = null;
  const reasons = [`最適化モード: ${profile.optimizationMode}`, `保護区分: ${protection}`];
  if (profile.optimizationMode === 'ROAS') {
    const actualRoas = safeNum(row.perf?.roas, 0);
    const targetRoas = safeNum(profile.effectiveRoasFloor ?? profile.roasFloor, autoSettings.roasFloor);
    if (!(actualRoas > 0 && targetRoas > 0)) return { action: 'HOLD', proposedCpc: null, reasons, blocks: ['ROAS実績または目標不足'] };
    const ratio = actualRoas / targetRoas;
    raw = ratio < 1 ? row.current * ratio : row.current * (1 + (ratio - 1) * 0.5);
    reasons.push(`ROAS ${Math.round(actualRoas)}% / 目標 ${targetRoas}%`);
  } else if (profile.optimizationMode === 'POSITION') {
    if (!posState.measured && !posState.achieved) {
      return { action: 'HOLD', proposedCpc: null, reasons, blocks: ['順位未測定'] };
    }
    if (posState.achieved) {
      return {
        action: 'HOLD',
        proposedCpc: null,
        reasons: [...reasons, `基準ワード「${posState.achievedKeyword || '設定語'}」がPC・SP目標順位を達成`],
        blocks: ['検索順位目標達成'],
      };
    }
    raw = row.source === '商品CPC'
      ? row.current + Math.max(1, safeNum(autoSettings.maxRaisePerDay, DEFAULT_AUTO_SETTINGS.maxRaisePerDay))
      : row.meyasu;
    reasons.push(`順位 ${posState.label} / 目安CPC ${row.meyasu}円`);
  } else if (profile.optimizationMode === 'BALANCED') {
    if (!posState.measured && !posState.achieved) {
      return { action: 'HOLD', proposedCpc: null, reasons, blocks: ['順位未測定'] };
    }
    const actualRoas = safeNum(row.perf?.roas, 0);
    const targetRoas = safeNum(profile.effectiveRoasFloor ?? profile.roasFloor, autoSettings.roasFloor);
    const positionCandidate = posState.achieved
      ? row.current
      : row.source === '商品CPC'
        ? row.current + Math.max(1, safeNum(autoSettings.maxRaisePerDay, DEFAULT_AUTO_SETTINGS.maxRaisePerDay))
        : safeNum(row.meyasu, 0);
    if (!(actualRoas > 0 && targetRoas > 0 && positionCandidate > 0)) {
      return { action: 'HOLD', proposedCpc: null, reasons, blocks: ['ROAS実績・目標または検索順位ベース提案不足'] };
    }
    const ratio = actualRoas / targetRoas;
    const roasCandidate = ratio < 1 ? row.current * ratio : row.current * (1 + (ratio - 1) * 0.5);
    raw = actualRoas < targetRoas
      ? Math.min(roasCandidate, positionCandidate)
      : positionCandidate > row.current ? Math.min(positionCandidate, roasCandidate) : positionCandidate;
    reasons.push(`ROAS ${Math.round(actualRoas)}% / 目標 ${targetRoas}%`);
    reasons.push(posState.achieved
      ? `基準ワード「${posState.achievedKeyword || '設定語'}」がPC・SP目標順位を達成`
      : `順位 ${posState.label} / 目安CPC ${row.meyasu}円`);
  } else {
    raw = safeNum(profile.fixedCpc, 0);
    if (!(raw > 0)) return { action: 'HOLD', proposedCpc: null, reasons, blocks: ['固定CPC未設定'] };
    reasons.push(`固定CPC ${raw}円`);
    const fixedFloor = row.source === '商品CPC' ? 20 : Math.max(40, autoSettings.floorCpc);
    const fixedCpc = Math.max(fixedFloor, Math.round(raw));
    if (fixedCpc === row.current) return { action: 'HOLD', proposedCpc: null, reasons, blocks: ['CPC変更なし'] };
    return { action: fixedCpc > row.current ? 'RAISE' : 'LOWER', proposedCpc: fixedCpc, reasons, blocks: [] };
  }
  const proposedCpc = clampProfileCpc(raw, row.current, row, profile, autoSettings);
  if (proposedCpc === row.current) return { action: 'HOLD', proposedCpc: null, reasons, blocks: ['CPC変更なし'] };
  return { action: proposedCpc > row.current ? 'RAISE' : 'LOWER', proposedCpc, reasons, blocks: [] };
}

function positionGoalLimit(goal, device) {
  if (goal === 'TOP_3') return 3;
  if (goal === 'TOP_5') return 5;
  if (goal === 'TOP_7') return 7;
  return device === 'pc' ? PC_FIRST_PAGE_RPP : SP_FIRST_PAGE_RPP;
}

function rppRankState(pos, profile = {}) {
  if (!pos) return { measured: false, achieved: false, achievedKeyword: null, pageOut: false, label: '未測定', noRppSlot: false, basisWords: [] };
  const candidates = Array.isArray(pos.basisWords) && pos.basisWords.length ? pos.basisWords : [pos];
  const pcLimit = positionGoalLimit(profile.pcPositionGoal || profile.positionGoal, 'pc');
  const spLimit = positionGoalLimit(profile.spPositionGoal || profile.positionGoal, 'sp');
  const labelOne = (rank, measured, hasSlot) => {
    if (!measured) return '未測定';
    if (!hasSlot) return '広告枠なし';
    return rank == null ? '圏外' : `${rank}位`;
  };
  const basisWords = candidates.map((candidate) => {
    const pc = candidate.pc || candidate;
    const sp = candidate.mobile || null;
    const pcRank = pc?.rppAdPosition ?? null;
    const spRank = sp?.rppAdPosition ?? null;
    const pcMeasured = Boolean(pc?.measured);
    const spMeasured = Boolean(sp?.measured);
    const pcHasSlot = pc?.hasRppSlot !== false;
    const spHasSlot = sp?.hasRppSlot !== false;
    const pcAchieved = pcMeasured && pcHasSlot && pcRank != null && pcRank <= pcLimit;
    const spAchieved = spMeasured && spHasSlot && spRank != null && spRank <= spLimit;
    return {
      keyword: candidate.searchKeyword || '',
      pcRank,
      spRank,
      pcMeasured,
      spMeasured,
      pcHasSlot,
      spHasSlot,
      achieved: pcAchieved && spAchieved,
      label: `PC ${labelOne(pcRank, pcMeasured, pcHasSlot)} / SP ${labelOne(spRank, spMeasured, spHasSlot)}`,
    };
  });
  const evaluableWords = basisWords.filter((word) => word.pcMeasured && word.spMeasured && word.pcHasSlot && word.spHasSlot);
  const achievedWord = evaluableWords.find((word) => word.achieved) || null;
  const measured = evaluableWords.length > 0;
  const noRppSlot = !measured && basisWords.some((word) => (word.pcMeasured && !word.pcHasSlot) || (word.spMeasured && !word.spHasSlot));
  const label = basisWords.map((word) => `${word.keyword ? `${word.keyword}: ` : ''}${word.label}${word.achieved ? '（達成）' : ''}`).join(' / ');
  return {
    measured,
    achieved: Boolean(achievedWord),
    achievedKeyword: achievedWord?.keyword || null,
    pageOut: measured && !achievedWord,
    noRppSlot,
    label,
    basisWords,
  };
}

function cpcCapFor(row, autoSettings) {
  return row.source === '商品CPC' ? autoSettings.itemCpcMax : autoSettings.keywordCpcMax;
}

function proposedRaise(current, meyasu, row, autoSettings) {
  return Math.min(meyasu, current + autoSettings.maxRaisePerDay, cpcCapFor(row, autoSettings));
}

function proposedLower(current, meyasu, autoSettings) {
  return Math.max(autoSettings.floorCpc, meyasu, current - autoSettings.maxLowerPerDay);
}

function classifyUp(row, posState, autoSettings) {
  const p = row.perf;
  const reasons = [];
  const blocks = [];
  if (!p) blocks.push('前日レポートに該当KWなし');
  else {
    if (safeNum(p.clicks) < 5) blocks.push(`クリック少（${safeNum(p.clicks)}）`);
    if (safeNum(p.roas) < autoSettings.roasFloor) blocks.push(`ROAS基準未満（${Math.round(safeNum(p.roas))}% < ${autoSettings.roasFloor}%）`);
    if (p.cvr != null && safeNum(p.cvr) < 5) blocks.push(`CVR低め（${p.cvr}%）`);
  }
  if (autoSettings.onlyRaiseWhenPageOut) {
    if (!posState.measured) blocks.push('順位未測定');
    else if (posState.noRppSlot) blocks.push('RPP広告枠なし');
    else if (!posState.pageOut) blocks.push('RPP順位は1ページ目内');
  }

  reasons.push(`目安CPC未満（${row.current}円 < ${row.meyasu}円）`);
  reasons.push(`順位 ${posState.label}`);
  if (p) reasons.push(`クリック${safeNum(p.clicks)} / ROAS${Math.round(safeNum(p.roas))}% / CVR${p.cvr ?? '-'}% / 売上${Math.round(safeNum(p.salesAmount)).toLocaleString()}円`);

  if (blocks.length) return { action: 'HOLD', proposedCpc: null, reasons, blocks };
  const proposedCpc = proposedRaise(row.current, row.meyasu, row, autoSettings);
  if (proposedCpc <= row.current) blocks.push(`CPC上限到達（上限${cpcCapFor(row, autoSettings)}円）`);
  if (blocks.length) return { action: 'HOLD', proposedCpc: null, reasons, blocks };
  return { action: 'RAISE', proposedCpc, reasons, blocks };
}

function classifyDown(row, posState, autoSettings) {
  const p = row.perf;
  const reasons = [`目安CPC超え（${row.current}円 > ${row.meyasu}円）`, `順位 ${posState.label}`];
  const blocks = [];
  if (!p) blocks.push('前日レポートに該当KWなし');
  else {
    reasons.push(`クリック${safeNum(p.clicks)} / ROAS${Math.round(safeNum(p.roas))}% / 売上${Math.round(safeNum(p.salesAmount)).toLocaleString()}円`);
  }
  if (!p || safeNum(p.clicks) < 5) return { action: 'HOLD', proposedCpc: null, reasons, blocks: blocks.length ? blocks : ['クリック少'] };

  const noSales = safeNum(p.salesAmount) <= 0;
  const lowRoas = safeNum(p.roas) < Math.min(autoSettings.roasFloor, 300);
  if (noSales || lowRoas) return { action: 'LOWER', proposedCpc: proposedLower(row.current, row.meyasu, autoSettings), reasons, blocks };
  return { action: 'HOLD', proposedCpc: null, reasons, blocks: ['売上/ROASがあるため下げ慎重'] };
}

function isUploadReady(candidate) {
  return (candidate.action === 'RAISE' || candidate.action === 'LOWER')
    && Number.isFinite(candidate.proposedCpc)
    && candidate.proposedCpc > 0
    && Array.isArray(candidate.blocks)
    && candidate.blocks.length === 0;
}

function profiledRecommendationRows(analysis, profiles) {
  return [...analysis.down, ...analysis.under, ...analysis.ok]
    .filter(row => profiles.has(`${row.itemCode}\t${row.keyword}`));
}

function isAutoAdjustmentActive(row, profiles, autoSettings) {
  if (!autoSettings.enabled) return false;
  const profile = profiles.get(`${row.itemCode}\t${row.keyword}`);
  return ['ROAS', 'POSITION', 'BALANCED'].includes(profile?.optimizationMode);
}

function buildRecommendations() {
  const settingsPath = path.join(PROJECT, arg('settings', 'rpp_keyword_settings.csv'));
  const itemSettingsPath = path.join(PROJECT, arg('item-settings', 'rpp_item_settings.csv'));
  const perfPath = path.join(PROJECT, arg('perf', 'rpp_keyword_reports.csv'));
  const itemPerfPath = path.join(PROJECT, arg('item-perf', 'rpp_item_reports.csv'));
  const excludePath = path.join(PROJECT, arg('exclude', 'rpp_exclude_items.csv'));
  const keywordSettings = loadSettings(settingsPath);
  const itemSettings = loadItemSettings(itemSettingsPath);
  const settings = [...itemSettings, ...keywordSettings];
  const keywordPerfMap = loadPerformance(perfPath);
  const itemPerfMap = loadItemPerformance(itemPerfPath);
  const productPerfMap = buildProductCpcPerformance(itemPerfMap, keywordPerfMap);
  const perfMap = new Map([...keywordPerfMap.entries(), ...productPerfMap.entries()]);
  const exclude = loadExcludeSet(excludePath);
  const profiles = loadTargetProfiles(path.join(PROJECT, arg('targets', 'rpp_targets/rpp_alert_targets.json')));
  const autoSettings = loadAutoSettings();
  const eligibleByExclusion = settings.filter(s => !(autoSettings.excludeRmsExcluded && (s.settingExcluded || exclude.has(s.itemCode))));
  const excludedCount = settings.length - eligibleByExclusion.length;
  const automatic = eligibleByExclusion.filter(s => isAutoAdjustmentActive(s, profiles, autoSettings));
  const skippedByAutoSettings = eligibleByExclusion.length - automatic.length;
  const { down, under, ok } = analyze(eligibleByExclusion, perfMap);
  const posMap = latestPositionMap();
  const roasBar = autoSettings.roasFloor;
  const recs = [];

  const add = (row, kind, profile = null) => {
    const inheritedProfile = profile || profiles.get(`${row.itemCode}\t${row.keyword}`) || profiles.get(`${row.itemCode}\t商品CPC`) || null;
    const posState = rppRankState(posMap[`${row.itemCode}\t${row.keyword}`], inheritedProfile || {});
    const c = inheritedProfile ? classifyProfile(row, posState, inheritedProfile, autoSettings) : (kind === 'up' ? classifyUp(row, posState, autoSettings) : classifyDown(row, posState, autoSettings));
    const direction = c.action === 'RAISE' ? 'up' : c.action === 'LOWER' ? 'down' : kind;
    recs.push({
      date: new Date().toISOString(),
      itemCode: row.itemCode,
      itemName: displayName(row.itemCode, row.itemName),
      keyword: row.keyword,
      direction,
      action: c.action,
      currentCpc: row.current,
      meyasuCpc: row.meyasu,
      proposedCpc: c.proposedCpc,
      delta: c.proposedCpc == null ? null : c.proposedCpc - row.current,
      source: row.source,
      clicks: row.perf?.clicks ?? null,
      spend: row.perf?.spend ?? null,
      salesAmount: row.perf?.salesAmount ?? null,
      roas: row.perf?.roas ?? null,
      cvr: row.perf?.cvr ?? null,
      rppPosition: posState.label,
      reasons: c.reasons,
      blocks: c.blocks,
      uploadReady: isUploadReady(c),
      optimizationMode: inheritedProfile?.optimizationMode || 'LEGACY',
      protectionType: inheritedProfile?.protectionType || 'NORMAL',
      experimentStartedAt: inheritedProfile?.experimentStartedAt || null,
      experimentEndDate: inheritedProfile?.experimentEndDate || null,
      experimentBaseline: inheritedProfile?.experimentBaseline || null,
      changeLocked: inheritedProfile?.protectionType === 'LOCKED' || Boolean(inheritedProfile?.changeLocked),
      lockReason: inheritedProfile?.lockReason || null,
      note: inheritedProfile?.protectionType === 'LOCKED' ? '変更不可リスト対象のためHOLD。' : '提案のみ。RMS反映なし。',
    });
  };
  const profiledKeys = new Set();
  for (const row of profiledRecommendationRows({ down, under, ok }, profiles)) {
    const key = `${row.itemCode}\t${row.keyword}`;
    const profile = profiles.get(key);
    profiledKeys.add(key);
    const kind = row.current < row.meyasu ? 'up' : 'down';
    add(row, kind, profile);
  }
  under.filter(r => !profiledKeys.has(`${r.itemCode}\t${r.keyword}`)).forEach(r => add(r, 'up'));
  down.filter(r => !profiledKeys.has(`${r.itemCode}\t${r.keyword}`)).forEach(r => add(r, 'down'));

  const freshness = dataFreshness();
  if (!freshness.readyForProduction) {
    const staleLabels = freshness.files.filter(f => !f.ok).map(f => `${f.fileName}:${f.status}`).join(' / ');
    for (const r of recs) {
      if (r.action === 'RAISE' || r.action === 'LOWER') {
        r.blocks = [...(r.blocks || []), `データ最新性NG（${staleLabels}）`];
        r.note = 'データが古い/未取得のためHOLD。本番反映不可。';
        r.action = 'HOLD';
        r.proposedCpc = null;
        r.delta = null;
        r.uploadReady = false;
      }
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    settingsRows: settings.length,
    activeRows: automatic.length,
    proposalScopeRows: eligibleByExclusion.length,
    excludedRows: excludedCount,
    skippedByAutoSettings,
    performanceRows: perfMap.size,
    keywordPerformanceRows: keywordPerfMap.size,
    itemPerformanceRows: itemPerfMap.size,
    productCpcEstimatedRows: productPerfMap.size,
    roasBar,
    targetProfileRows: profiles.size,
    counts: {
      raise: recs.filter(r => r.action === 'RAISE').length,
      lower: recs.filter(r => r.action === 'LOWER').length,
      hold: recs.filter(r => r.action === 'HOLD').length,
      ok: ok.length,
    },
    safety: {
      floorCpc: autoSettings.floorCpc,
      maxRaise: autoSettings.maxRaisePerDay,
      maxLower: autoSettings.maxLowerPerDay,
      autoAdjustment: autoSettings,
      productionChange: false,
      dataFreshness: freshness,
    },
  };
  return { summary, recommendations: recs };
}

function csvEscape(v) {
  const s = Array.isArray(v) ? v.join(' / ') : String(v ?? '');
  return `"${s.replace(/"/g, '""')}"`;
}

function writeCsv(filePath, rows) {
  const header = ['action','itemCode','itemName','keyword','currentCpc','meyasuCpc','proposedCpc','delta','clicks','spend','salesAmount','roas','cvr','rppPosition','changeLocked','lockReason','reasons','blocks','note'];
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) lines.push(header.map(h => csvEscape(r[h])).join(','));
  fs.writeFileSync(filePath, iconv.encode(lines.join('\r\n') + '\r\n', 'utf8'));
}

function buildNotifyText(result) {
  const { summary, recommendations } = result;
  const actionable = recommendations.filter(r => r.action === 'RAISE' || r.action === 'LOWER');
  const hold = recommendations.filter(r => r.action === 'HOLD');
  const lines = [];
  lines.push(`RPP広告ON調整候補: 上げ${summary.counts.raise} / 下げ${summary.counts.lower} / 保留${summary.counts.hold}`);
  lines.push('※RMS反映なし。確認用候補の生成のみ。');
  if (actionable.length) {
    lines.push('▼変更候補');
    for (const r of actionable.slice(0, 8)) {
      const arrow = `${r.currentCpc}円 → ${r.proposedCpc}円`;
      const perf = r.clicks == null ? '実績なし' : `クリック${r.clicks} / ROAS${Math.round(safeNum(r.roas))}% / 売上${Math.round(safeNum(r.salesAmount)).toLocaleString()}円`;
      lines.push(`・${r.action === 'RAISE' ? '上げ' : '下げ'} ${r.itemName} ${r.itemCode}`);
      lines.push(`　KW: ${r.keyword}`);
      lines.push(`　CPC: ${arrow} / ${r.rppPosition}`);
      lines.push(`　実績: ${perf}`);
    }
    if (actionable.length > 8) lines.push(`・ほか${actionable.length - 8}件`);
  } else {
    lines.push('▼承認候補なし');
  }
  if (hold.length) lines.push(`▼保留: ${hold.length}件（実績不足/順位内/ROAS基準未満など）`);
  return lines.join('\n');
}

async function syncTargetProfiles() {
  if (process.argv.includes('--no-target-sync')) return { skipped: true };
  const url = arg('targets-url', process.env.RPP_TARGETS_URL || 'https://rakuten-mvp-web.onrender.com/api/rpp/sync-snapshot?resource=targets');
  const targetPath = path.join(PROJECT, arg('targets', 'rpp_targets/rpp_alert_targets.json'));
  try {
    let token = String(process.env.RPP_SNAPSHOT_SYNC_TOKEN || '').trim();
    if (!token && process.platform === 'darwin') {
      try {
        token = execFileSync('security', ['find-generic-password', '-s', 'hermes.rpp.snapshot-sync', '-w'], { encoding: 'utf8' }).trim();
      } catch (_) {}
    }
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.targets)) throw new Error('targets配列なし');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tmp = `${targetPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), source: url, targets: data.targets }, null, 2), 'utf8');
    fs.renameSync(tmp, targetPath);
    return { ok: true, count: data.targets.length, targetPath };
  } catch (error) {
    console.error(`WARN 目標同期失敗。ローカル保存値で継続: ${error.message}`);
    return { ok: false, error: error.message, targetPath };
  }
}

async function main() {
  if (process.argv.includes('--runtime-preflight')) {
    if (!process.env.RPP_PROJECT_DIR || !fs.existsSync(PROJECT) || path.resolve(__dirname) === PROJECT) {
      throw new Error('private generation data root is not configured');
    }
    console.log(JSON.stringify({ ok: true, mode: 'runtime-preflight', project: PROJECT }));
    return;
  }
  const targetSync = await syncTargetProfiles();
  const result = buildRecommendations();
  result.summary.targetSync = targetSync;
  const outDir = path.join(PROJECT, 'rpp_recommendations');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = todayStamp();
  const jsonPath = path.resolve(arg('json', path.join(outDir, `rpp_auto_recommendations_${stamp}.json`)));
  const csvPath = path.resolve(arg('csv', path.join(outDir, `rpp_auto_recommendations_${stamp}.csv`)));
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf8');
  writeCsv(csvPath, result.recommendations);

  console.log(JSON.stringify({ ok: true, json: jsonPath, csv: csvPath, summary: result.summary }, null, 2));

  if (process.argv.some(a => a.startsWith('--out=')) || process.argv.includes('--notify')) {
    const text = buildNotifyText(result);
    const summary = `RPP広告ON調整候補 上げ${result.summary.counts.raise}・下げ${result.summary.counts.lower}・保留${result.summary.counts.hold}`;
    if (process.argv.includes('--notify')) {
      const { sendChatwork } = require('./chatwork_notify');
      await emit(text, () => sendChatwork(text), { summary });
    } else {
      await emit(text, async () => {}, { summary });
    }
  }
}

if (require.main === module) main().catch(e => { console.error(`❌ エラー: ${e.stack || e.message}`); process.exitCode = 1; });
module.exports = { buildRecommendations, buildNotifyText, syncTargetProfiles, classifyProfile, isAutoAdjustmentActive, isUploadReady, loadTargetProfiles, profiledRecommendationRows, rppRankState };
