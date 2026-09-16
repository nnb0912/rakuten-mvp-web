const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function readCsv(filePath) {
  const buf = fs.readFileSync(filePath);
  let text = iconv.decode(buf, 'shift_jis');
  if (/[縺繧繝]/.test(text.slice(0, 1000))) text = buf.toString('utf8');
  return text.split(/\r?\n/).filter(l => l.trim()).map(splitCsvLine);
}

const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[¥,%\s"]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function findCol(header, names) {
  for (const name of names) {
    const i = header.findIndex(h => h === name || h.includes(name));
    if (i >= 0) return i;
  }
  return -1;
}

function loadSettings(filePath) {
  const rows = readCsv(filePath);
  const headerIdx = rows.findIndex(r => r.some(c => c.includes('商品管理番号')));
  if (headerIdx === -1) throw new Error(`ヘッダー行が見つかりません: ${filePath}`);
  const header = rows[headerIdx];
  const c = {
    itemCode: findCol(header, ['商品管理番号']),
    rakutenName: findCol(header, ['商品名']),
    keyword: findCol(header, ['キーワード']),
    kwCpc: findCol(header, ['キーワードCPC']),
    meyasu: findCol(header, ['目安CPC']),
  };
  const parsed = rows.slice(headerIdx + 1).map(r => ({
    itemCode: r[c.itemCode] || '',
    rakutenName: r[c.rakutenName] || '',
    keyword: r[c.keyword] || '',
    kwCpc: c.kwCpc >= 0 ? num(r[c.kwCpc]) : null,
    meyasu: c.meyasu >= 0 ? num(r[c.meyasu]) : null,
  })).filter(x => x.itemCode);
  const representativeKw = {};
  for (const x of parsed) {
    if (x.keyword && representativeKw[x.itemCode] == null) representativeKw[x.itemCode] = x.keyword;
  }
  return parsed.map(x => {
    if (!x.keyword) return { ...x, keyword: representativeKw[x.itemCode] || x.rakutenName, representativeKeyword: true };
    return x;
  }).filter(x => x.itemCode && x.keyword);
}

function loadPerformance(filePath) {
  const rows = readCsv(filePath);
  const headerIdx = rows.findIndex(r => r.some(c => c.includes('商品管理番号')));
  if (headerIdx === -1) return { map: new Map(), period: '' };
  const header = rows[headerIdx];
  const c = {
    date: findCol(header, ['日付']),
    itemCode: findCol(header, ['商品管理番号']), keyword: findCol(header, ['キーワード']),
    impressions: findCol(header, ['表示回数', 'インプレッション']), clicks: findCol(header, ['クリック数(合計)', 'クリック数']),
    spend: findCol(header, ['実績額(合計)', '広告費', '実績額']), sales: findCol(header, ['売上金額', '売上額']),
    orders: findCol(header, ['売上件数', '注文数']), roas: findCol(header, ['ROAS']), ctr: findCol(header, ['CTR']), cvr: findCol(header, ['CVR']),
  };
  const map = new Map();
  const dates = new Set();
  const normDate = (s) => {
    const m = String(s || '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : '';
  };
  for (const r of rows.slice(headerIdx + 1)) {
    if (c.date >= 0) {
      const d = normDate(r[c.date]);
      if (d) dates.add(d);
    }
    const key = `${r[c.itemCode]}\t${r[c.keyword]}`;
    map.set(key, {
      impressions: c.impressions >= 0 ? (num(r[c.impressions]) ?? 0) : 0,
      clicks: c.clicks >= 0 ? (num(r[c.clicks]) ?? 0) : 0,
      spend: c.spend >= 0 ? (num(r[c.spend]) ?? 0) : 0,
      sales: c.sales >= 0 ? (num(r[c.sales]) ?? 0) : 0,
      orders: c.orders >= 0 ? (num(r[c.orders]) ?? 0) : 0,
      roas: c.roas >= 0 ? num(r[c.roas]) : null,
      ctr: c.ctr >= 0 ? num(r[c.ctr]) : null,
      cvr: c.cvr >= 0 ? num(r[c.cvr]) : null,
    });
  }
  const period = dates.size === 1 ? `daily:${[...dates][0]}` : '';
  return { map, period };
}

function loadExcludeSet(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  const rows = readCsv(filePath);
  const headerIdx = rows.findIndex(r => r.some(c => c.includes('商品管理番号')));
  if (headerIdx === -1) return new Set();
  const col = rows[headerIdx].findIndex(h => h.includes('商品管理番号'));
  return new Set(rows.slice(headerIdx + 1).map(r => (r[col] || '').trim()).filter(Boolean));
}

module.exports = { loadSettings, loadPerformance, loadExcludeSet };
