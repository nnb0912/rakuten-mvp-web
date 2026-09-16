const fs = require('fs');
const path = require('path');
const PROJECT = path.resolve(process.env.RPP_PROJECT_DIR || __dirname);

function actionJa(action) {
  const labels = {
    RAISE: 'CPCを上げる',
    LOWER: 'CPCを下げる',
    MAINTAIN: '維持',
    SKIP: '調整しない',
    ROAS_GUARD: 'ROAS低いため上げない',
  };
  return labels[action] || action || '';
}

function normalizePosition(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatRank(value, missing = '未測定') {
  const n = normalizePosition(value);
  return n === null ? missing : `${n}位`;
}

function firstPageRank(value) {
  return formatRank(value, '圏外');
}

function normalizeDevice(adj, prefix = '') {
  const cap = prefix ? prefix[0].toUpperCase() + prefix.slice(1) : '';
  const screenPosition = normalizePosition(adj[`${prefix}ScreenPosition`] ?? adj[`${prefix}MeasuredPosition`] ?? adj[`${prefix}Position`] ?? (!prefix ? (adj.screenPosition ?? adj.measuredPosition ?? adj.position ?? adj.rank) : null));
  const rppAdPosition = normalizePosition(adj[`${prefix}RppAdPosition`] ?? adj[`${prefix}RppPosition`] ?? adj[`${prefix}AdPosition`] ?? adj[`${prefix}PrPosition`] ?? (!prefix ? (adj.rppAdPosition ?? adj.rppPosition ?? adj.adPosition ?? adj.prPosition) : null));
  const organicPosition = normalizePosition(adj[`${prefix}OrganicPosition`] ?? adj[`${prefix}NormalPosition`] ?? adj[`${prefix}NaturalPosition`] ?? (!prefix ? (adj.organicPosition ?? adj.normalPosition ?? adj.naturalPosition) : null));
  const hasRppSlot = adj[`${prefix}HasRppSlot`] ?? adj[`${prefix}RppSlot`] ?? (!prefix ? (adj.hasRppSlot ?? adj.rppSlot) : undefined);
  const isRpp = Boolean(adj[`${prefix}IsRpp`] || adj[`${prefix}IsPr`] || (!prefix && (adj.isRpp || adj.isPr || adj.pr || adj.adType === 'RPP' || adj.positionType === 'RPP' || adj.rankType === 'RPP')));
  const measured = Boolean(adj[`${prefix}Measured`] || screenPosition !== null || rppAdPosition !== null || organicPosition !== null || hasRppSlot !== undefined);
  return {
    screenPosition,
    rppAdPosition: rppAdPosition ?? (isRpp ? screenPosition : null),
    organicPosition: organicPosition ?? (isRpp ? null : screenPosition),
    hasRppSlot,
    measured,
    isRpp,
  };
}

function latestPositionMap(filePath = path.join(PROJECT, 'rpp_position_adjustment_log.json')) {
  const map = {};
  if (!fs.existsSync(filePath)) return map;
  try {
    const posLog = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const arr = Array.isArray(posLog) ? posLog : (posLog.entries || []);
    if (arr.length === 0) return map;
    const latest = arr[arr.length - 1];
    for (const adj of (latest.adjustments || [])) {
      const key = `${adj.itemCode}\t${adj.keyword}`;
      const pc = normalizeDevice(adj, 'pc');
      const mobile = normalizeDevice(adj, 'mobile');
      const base = normalizeDevice(adj, '');
      const candidate = {
        ...base,
        searchKeyword: adj.searchKeyword || adj.keyword,
        pc: pc.measured ? pc : base,
        mobile: mobile.measured ? mobile : null,
        checkedAt: latest.timestamp || adj.checkedAt || adj.timestamp,
        action: adj.action,
        actionJa: adj.actionJa || actionJa(adj.action),
      };
      if (map[key]) {
        map[key].basisWords.push(candidate);
      } else {
        map[key] = { ...candidate, basisWords: [candidate] };
      }
    }
  } catch (e) {
    return {};
  }
  return map;
}

function rppLabel(info) {
  if (!info || !info.measured) return '未測定';
  if (info.rppAdPosition !== null && info.rppAdPosition !== undefined) return formatRank(info.rppAdPosition);
  if (info.hasRppSlot === false) return '広告枠なし';
  return '圏外';
}

function formatDevicePosition(info) {
  if (!info || !info.measured) return '通常検索:未測定 ／ RPP広告:未測定';
  const organic = firstPageRank(info.organicPosition);
  const rpp = rppLabel(info);
  const screen = formatRank(info.screenPosition, '圏外');
  if (info.screenPosition !== null && info.screenPosition !== undefined && organic !== screen && rpp !== screen) {
    return `通常検索:${organic} ／ RPP広告:${rpp} ／ 画面表示:${screen}`;
  }
  return `通常検索:${organic} ／ RPP広告:${rpp}`;
}

function formatCheckedAt(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

function formatPositionInfo(info) {
  if (!info || !(info.measured || info.pc?.measured || info.mobile?.measured)) return 'PC 通常検索:未測定・RPP広告:未測定 ／ スマホ 通常検索:未測定・RPP広告:未測定';
  const pc = info.pc || info;
  const mobile = info.mobile;
  const pcOrganic = firstPageRank(pc.organicPosition);
  const mobileOrganic = mobile ? firstPageRank(mobile.organicPosition) : '未測定';
  const pcRpp = rppLabel(pc);
  const mobileRpp = mobile ? rppLabel(mobile) : '未測定';
  const checked = formatCheckedAt(info.checkedAt);
  const checkedText = checked ? `（${checked}測定）` : '';
  return `PC 通常検索:${pcOrganic}・RPP広告:${pcRpp} ／ スマホ 通常検索:${mobileOrganic}・RPP広告:${mobileRpp}${checkedText}`;
}

module.exports = { latestPositionMap, formatPositionInfo, formatDevicePosition, actionJa };
