const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

const PROJECT = path.resolve(process.env.RPP_PROJECT_DIR || __dirname);
const DEFAULT_THRESHOLDS = {
  'rpp_keyword_settings.csv': 24,
  'rpp_item_settings.csv': 24,
  'rpp_exclude_items.csv': 24,
  'rpp_keyword_reports.csv': 36,
  'rpp_item_reports.csv': 36,
  'rpp_item_reports_7d.csv': 36,
  'rpp_position_adjustment_log.json': 24,
};

function decode(raw) {
  for (const enc of ['shift_jis', 'cp932', 'utf8']) {
    try { return iconv.decode(raw, enc); } catch (_) {}
  }
  return raw.toString('utf8');
}

function parseCsvLine(line) {
  const cells = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (c === ',' && !q) { cells.push(cur); cur = ''; }
    else cur += c;
  }
  cells.push(cur);
  return cells;
}

function readCsv(filePath) {
  const text = decode(fs.readFileSync(filePath));
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

function fileFreshness(fileName, maxAgeHours = DEFAULT_THRESHOLDS[fileName] ?? 24) {
  const filePath = path.join(PROJECT, fileName);
  if (!fs.existsSync(filePath)) return { fileName, filePath, ok: false, status: 'missing', ageHours: null, maxAgeHours, mtime: null };
  const st = fs.statSync(filePath);
  const ageHours = (Date.now() - st.mtimeMs) / 36e5;
  return { fileName, filePath, ok: ageHours <= maxAgeHours, status: ageHours <= maxAgeHours ? 'ok' : 'stale', ageHours, maxAgeHours, mtime: st.mtime.toISOString() };
}

function dataFreshness() {
  const files = Object.entries(DEFAULT_THRESHOLDS).map(([name, hours]) => fileFreshness(name, hours));
  return { readyForProduction: files.every(f => f.ok), files };
}

function latestCpcMap(
  keywordSettingsPath = path.join(PROJECT, 'rpp_keyword_settings.csv'),
  itemSettingsPath = path.join(PROJECT, 'rpp_item_settings.csv'),
) {
  const rows = readCsv(keywordSettingsPath);
  const map = new Map();
  for (const row of rows) {
    const itemCode = row['商品管理番号'];
    const keyword = row['キーワード'];
    if (!itemCode || !keyword) continue;
    const keywordCpc = Number(row['キーワードCPC']);
    const itemCpc = Number(row['商品CPC']);
    map.set(`${itemCode}\t${keyword}`, Number.isFinite(keywordCpc) ? keywordCpc : itemCpc);
  }
  for (const row of readCsv(itemSettingsPath)) {
    const itemCode = row['商品管理番号'];
    const itemCpc = Number(row['商品CPC']);
    if (!itemCode || !Number.isFinite(itemCpc)) continue;
    map.set(`${itemCode}\t商品CPC`, itemCpc);
  }
  return map;
}

module.exports = { dataFreshness, fileFreshness, latestCpcMap, readCsv };
