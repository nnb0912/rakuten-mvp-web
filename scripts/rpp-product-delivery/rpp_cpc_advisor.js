/**
 * RPP CPCアドバイザー（上司方針の段階1）
 * ============================================================
 * 登録済みキーワードの「設定CPC」と楽天の「目安CPC（推奨）」を比較して、
 *
 *   ① 下げ候補   : 設定CPC が 目安CPC より高い → 下げても露出は変わらないはず
 *   ② 推奨未達   : 設定CPC が 目安CPC より低い → 出したいのに出ていない可能性（可視化のみ）
 *
 * を一覧化する。※このスクリプトはRMSに何もアップロードしない（読み取り＆ファイル生成のみ）
 *
 * 使い方:
 *   node rpp_cpc_advisor.js
 *   node rpp_cpc_advisor.js --settings=rpp_downloads/rpp_item_keyword_real.csv
 *   node rpp_cpc_advisor.js --notify        … 結果をChatworkにも送る
 *   node rpp_cpc_advisor.js --out=ファイル … 送らずに通知本文をファイルへ書く
 *                                             （朝8時のまとめ送信用。rpp_notify_combine.js が集める）
 *
 * 入力:
 *   設定CSV（商品・キーワード設定 → 登録済みキーワード全件ダウンロード）
 *     列: コントロールカラム,商品管理番号,商品名,価格,商品URL,商品CPC,キーワード,キーワードCPC,目安CPC
 *   実績CSV（rpp_keyword_reports.csv + rpp_item_reports.csv）
 *   商品CPC実績は「商品別実績 − 同一商品のキーワード別実績合計」で推定する。
 *
 * 出力:
 *   rpp_cpc_report_YYYYMMDD.csv … 上司さん確認用の一覧（Excelで開ける）
 *   rpp_uploads/cpc_down_YYYYMMDDHHMM.csv … ①下げ候補の一括アップロード用CSV（生成のみ・アップロードしない）
 * ============================================================
 */

const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

const PROJECT = path.resolve(process.env.RPP_PROJECT_DIR || __dirname);
const CONFIG = JSON.parse(fs.readFileSync(path.join(PROJECT, 'rpp_config.json'), 'utf8'));
const log = (msg) => console.log(`[cpc-advisor] ${msg}`);

// RPPの最低CPC（これ未満には下げられない）
const FLOOR_CPC = 40;

// ---- CSVユーティリティ ----
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

function readSjisCsv(filePath) {
  const buf = fs.readFileSync(filePath);
  let text = iconv.decode(buf, 'shift_jis');
  if (/[縺繧繝]/.test(text.slice(0, 1000))) text = buf.toString('utf8'); // UTF-8だった場合の保険
  return text.split(/\r?\n/).filter(l => l.trim()).map(splitCsvLine);
}

const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[¥,%\s"]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// ---- 設定CSV読み込み ----
function loadSettings(filePath) {
  const rows = readSjisCsv(filePath);
  const headerIdx = rows.findIndex(r => r.some(c => c.includes('コントロールカラム')));
  if (headerIdx === -1) throw new Error(`ヘッダー行が見つかりません: ${filePath}`);
  const header = rows[headerIdx];
  const col = (name) => header.findIndex(h => h.includes(name));
  const c = {
    itemCode: col('商品管理番号'), itemName: col('商品名'), itemCpc: col('商品CPC'),
    keyword: col('キーワード'), kwCpc: col('キーワードCPC'), meyasu: col('目安CPC'),
  };
  const parsed = rows.slice(headerIdx + 1).map(r => ({
    itemCode: r[c.itemCode] || '',
    itemName: (r[c.itemName] || '').slice(0, 30),
    itemCpc: num(r[c.itemCpc]),
    keyword: r[c.keyword] || '',
    kwCpc: num(r[c.kwCpc]),
    meyasu: num(r[c.meyasu]),
  })).filter(x => x.itemCode);

  // 商品CPCだけの商品は、同一商品の登録KWから代表KWを1つ補完して順位測定にも使う。
  const representativeKw = {};
  for (const x of parsed) {
    if (x.keyword && representativeKw[x.itemCode] == null) representativeKw[x.itemCode] = x.keyword;
  }
  return parsed.map(x => {
    if (!x.keyword) return { ...x, keyword: representativeKw[x.itemCode] || x.itemName, representativeKeyword: true };
    return x;
  }).filter(x => x.itemCode && x.keyword);
}

// ---- 商品CPC設定読み込み（商品単位のCPC行） ----
function loadItemSettings(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const rows = readSjisCsv(filePath);
  const headerIdx = rows.findIndex(r => r.some(c => c.includes('コントロールカラム')));
  if (headerIdx === -1) return [];
  const header = rows[headerIdx];
  const col = (name) => header.findIndex(h => h.includes(name));
  const c = { itemCode: col('商品管理番号'), itemName: col('商品名'), itemCpc: col('商品CPC'), excluded: col('除外登録済み商品') };
  return rows.slice(headerIdx + 1).map(r => ({
    itemCode: r[c.itemCode] || '',
    itemName: (r[c.itemName] || '').slice(0, 30),
    itemCpc: num(r[c.itemCpc]),
    keyword: '商品CPC',
    kwCpc: null,
    meyasu: num(r[c.itemCpc]),
    settingExcluded: String(r[c.excluded] || '').trim().toLowerCase() === 'yes',
    representativeKeyword: false,
    productCpcRow: true,
  })).filter(x => x.itemCode && x.itemCpc != null);
}

// ---- 商品別実績を商品CPC分へ差し引き変換 ----
function perfZero() { return { impressions: 0, clicks: 0, spend: 0, roas: 0, sales: 0, salesAmount: 0, cvr: null, ctr: null }; }
function estimateImpressions(p) {
  if (p.impressions != null) return p.impressions;
  return p.ctr > 0 && p.clicks > 0 ? Math.round(p.clicks / (p.ctr / 100)) : 0;
}
function addPerf(a, b) {
  return {
    impressions: (a.impressions ?? 0) + estimateImpressions(b),
    clicks: (a.clicks ?? 0) + (b.clicks ?? 0),
    spend: (a.spend ?? 0) + (b.spend ?? 0),
    sales: (a.sales ?? 0) + (b.sales ?? 0),
    salesAmount: (a.salesAmount ?? 0) + (b.salesAmount ?? 0),
    roas: 0, cvr: null, ctr: null,
  };
}
function loadItemPerformance(filePath) {
  if (!fs.existsSync(filePath)) return new Map();
  const raw = loadPerformance(filePath);
  const byItem = new Map();
  for (const [key, perf] of raw.entries()) {
    const itemCode = key.split('\t')[0];
    byItem.set(itemCode, addPerf(byItem.get(itemCode) || perfZero(), perf));
  }
  for (const [itemCode, p] of byItem.entries()) {
    p.roas = p.spend > 0 ? (p.salesAmount / p.spend) * 100 : 0;
    p.cvr = p.clicks > 0 ? (p.sales / p.clicks) * 100 : null;
    byItem.set(itemCode, p);
  }
  return byItem;
}
function buildProductCpcPerformance(itemPerfMap, keywordPerfMap) {
  const kwByItem = new Map();
  for (const [key, perf] of keywordPerfMap.entries()) {
    const itemCode = key.split('\t')[0];
    kwByItem.set(itemCode, addPerf(kwByItem.get(itemCode) || perfZero(), perf));
  }
  const residual = new Map();
  for (const [itemCode, total] of itemPerfMap.entries()) {
    const kw = kwByItem.get(itemCode) || perfZero();
    const p = {
      clicks: Math.max(0, (total.clicks ?? 0) - (kw.clicks ?? 0)),
      impressions: Math.max(0, (total.impressions ?? 0) - (kw.impressions ?? 0)),
      spend: Math.max(0, (total.spend ?? 0) - (kw.spend ?? 0)),
      sales: Math.max(0, (total.sales ?? 0) - (kw.sales ?? 0)),
      salesAmount: Math.max(0, (total.salesAmount ?? 0) - (kw.salesAmount ?? 0)),
      ctr: null,
      cvr: null,
      roas: 0,
      basis: '商品別実績−キーワード別実績合計',
    };
    p.roas = p.spend > 0 ? (p.salesAmount / p.spend) * 100 : 0;
    p.cvr = p.clicks > 0 ? (p.sales / p.clicks) * 100 : null;
    p.ctr = p.impressions > 0 ? (p.clicks / p.impressions) * 100 : null;
    residual.set(`${itemCode}\t商品CPC`, p);
  }
  return residual;
}

// ---- 除外商品リスト読み込み（あれば。除外中の商品は提案対象から分離する） ----
function loadExcludeList(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  const rows = readSjisCsv(filePath);
  const headerIdx = rows.findIndex(r => r.some(c => c.includes('商品管理番号')));
  if (headerIdx === -1) return new Set();
  const col = rows[headerIdx].findIndex(h => h.includes('商品管理番号'));
  const set = new Set();
  for (const r of rows.slice(headerIdx + 1)) {
    if (r[col]) set.add(r[col].trim());
  }
  return set;
}

// ---- 実績CSV読み込み（あれば。商品×キーワードで結合してクリック等を併記） ----
function loadPerformance(filePath) {
  if (!fs.existsSync(filePath)) return new Map();
  const rows = readSjisCsv(filePath);
  const headerIdx = rows.findIndex(r => r.some(c => c.includes('コントロールカラム')));
  if (headerIdx === -1) return new Map();
  const header = rows[headerIdx];
  const col = (name) => header.findIndex(h => h === name || h.includes(name));
  const c = {
    itemCode: col('商品管理番号'), keyword: col('キーワード'),
    impressions: col('表示回数'),
    clicks: col('クリック数(合計)'), spend: col('実績額(合計)'),
    roas: col('ROAS(合計12時間)'), sales: col('売上件数(合計12時間)'),
    salesAmount: col('売上金額(合計12時間)'), cvr: col('CVR(合計12時間)(%)'),
    ctr: col('CTR(%)'),
  };
  const map = new Map();
  for (const r of rows.slice(headerIdx + 1)) {
    const key = `${r[c.itemCode]}\t${r[c.keyword]}`;
    map.set(key, {
      impressions: c.impressions >= 0 ? (num(r[c.impressions]) ?? 0) : null,
      clicks: num(r[c.clicks]) ?? 0,
      spend: num(r[c.spend]) ?? 0,
      roas: num(r[c.roas]) ?? 0,
      sales: num(r[c.sales]) ?? 0,
      salesAmount: num(r[c.salesAmount]) ?? 0,
      cvr: num(r[c.cvr]),
      ctr: num(r[c.ctr]),
    });
  }
  return map;
}

// ---- 判定 ----
function analyze(settings, perfMap) {
  const down = [];   // ①下げ候補: 設定 > 目安
  const under = [];  // ②推奨未達: 設定 < 目安
  const ok = [];     // ちょうど目安どおり

  for (const s of settings) {
    // 実効CPC = キーワードCPCがあればそれ、なければ商品CPC
    const current = s.kwCpc ?? s.itemCpc;
    if (current == null || s.meyasu == null) continue;
    const perf = perfMap.get(`${s.itemCode}\t${s.keyword}`) || null;
    const row = { ...s, current, source: s.kwCpc != null ? 'キーワードCPC' : '商品CPC', perf };

    if (current > s.meyasu) {
      row.proposed = Math.max(s.meyasu, FLOOR_CPC); // 目安まで下げる（最低40円）
      row.saving = current - row.proposed;
      down.push(row);
    } else if (current < s.meyasu) {
      row.gap = s.meyasu - current;
      under.push(row);
    } else {
      ok.push(row);
    }
  }

  down.sort((a, b) => b.saving - a.saving);
  under.sort((a, b) => (b.perf?.clicks ?? 0) - (a.perf?.clicks ?? 0) || b.gap - a.gap);
  return { down, under, ok };
}

// 採算ラインは商品チェックアラートと同じ基準を使う（rpp_alert_config.json）
function loadRoasBar() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(PROJECT, 'rpp_alert_config.json'), 'utf8'));
    return c.rules?.roas?.['ROASがこの%未満なら候補'] ?? 500;
  } catch (e) {
    return 500;
  }
}

/**
 * 「なぜ上げる/下げる価値があるのか」を実績から一言で説明する
 *
 * 目安CPCとの差だけでは動いてよいか分からない。
 * 稼いでいるキーワードを下げれば売上を落とし、赤字のキーワードを上げれば損が増えるため、
 * 直近の ROAS・クリック数を根拠として添える。
 *
 * @param {Object} r      判定済みの1行（perf に実績が入っている）
 * @param {'up'|'down'} kind
 * @param {number} roasBar 採算ライン(%)
 */
function reasonOf(r, kind, roasBar) {
  const p = r.perf;
  if (!p) return '実績: 前日レポートに該当KWなし';
  if (p.clicks === 0) return '実績: 前日クリック0';
  const roas = p.roas != null ? Math.round(p.roas) : null;
  const sales = p.salesAmount ? `${Math.round(p.salesAmount).toLocaleString()}円` : (p.sales ? `${p.sales}件` : '0件');
  let verdict = '';
  if (kind === 'up') {
    if (roas != null && roas >= roasBar) verdict = '上げ候補';
    else if (p.sales === 0) verdict = 'ページ確認優先';
    else verdict = '上げ慎重';
  } else if (roas != null && roas >= roasBar) verdict = '下げ慎重';
  else verdict = '下げ候補';
  const parts = [`実績: クリック${p.clicks}`, `12h ROAS${roas ?? '-'}%`, `12h売上${sales}`];
  if (p.ctr != null) parts.push(`CTR${p.ctr}%`);
  if (p.cvr != null) parts.push(`CVR${p.cvr}%`);
  parts.push(`判断:${verdict}`);
  return parts.join(' ／ ');
}

// ---- 出力: 上司さん確認用CSV（UTF-8 BOM・Excelでそのまま開ける） ----
function writeReport(down, under, ok, excluded, outPath) {
  const header = '区分,商品管理番号,商品名,キーワード,現在CPC,CPCの種類,目安CPC,差額,提案,実績根拠,クリック数(日次),実績額(日次),売上件数(12h),売上金額(12h),CVR12h(%),ROAS12h(%)';
  const line = (cat, r, extra) => [
    cat, r.itemCode, `"${r.itemName}"`, `"${r.keyword}"`, r.current, r.source, r.meyasu, extra,
    r.perf ? `目安${r.meyasu}円に${cat === '下げ候補' ? '下げる' : '上げると露出改善の可能性'}` : (cat === '下げ候補' ? `目安${r.meyasu}円に下げる` : '実績なし(表示されていない可能性大)'),
    r.perf?.basis ?? (r.source === '商品CPC' ? '商品別実績未取得' : 'キーワード別実績'),
    r.perf?.clicks ?? 0, r.perf?.spend ?? 0, r.perf?.sales ?? 0, r.perf?.salesAmount ?? 0, r.perf?.cvr ?? '', r.perf?.roas ?? '',
  ].join(',');
  const exLine = (s) => [
    '除外中(広告停止)', s.itemCode, `"${s.itemName}"`, `"${s.keyword}"`, s.kwCpc ?? s.itemCpc ?? '',
    s.kwCpc != null ? 'キーワードCPC' : '商品CPC', s.meyasu ?? '', '',
    'RMS除外商品に登録中のため提案対象外', '', '', '', '', '', '', '',
  ].join(',');
  const rows = [
    ...down.map(r => line('下げ候補', r, `-${r.saving}`)),
    ...under.map(r => line('推奨未達', r, `+${r.gap}`)),
    ...ok.map(r => line('目安どおり', r, '0')),
    ...excluded.map(exLine),
  ];
  fs.writeFileSync(outPath, '﻿' + header + '\r\n' + rows.join('\r\n') + '\r\n', 'utf8');
}

// ---- 出力: 下げ候補の一括アップロード用CSV（生成のみ。アップロードはしない） ----
function writeUploadCsv(down, outPath) {
  const header = '"コントロールカラム","商品管理番号","キーワード","キーワードCPC"';
  const rows = down.filter(r => r.source === 'キーワードCPC').map(r => `"u","${r.itemCode}","${r.keyword}","${r.proposed}"`);
  fs.writeFileSync(outPath, iconv.encode(header + '\r\n' + rows.join('\r\n') + '\r\n', 'shift_jis'));
}

// ---- メイン ----
async function main() {
  const arg = (name, def) => {
    const a = process.argv.find(x => x.startsWith(`--${name}=`));
    return a ? a.split('=')[1] : def;
  };
  // 設定CSV: rpp_settings_downloader.js が作る最新版を優先。無ければ旧手動ファイル
  const defaultSettings = fs.existsSync(path.join(PROJECT, 'rpp_keyword_settings.csv'))
    ? 'rpp_keyword_settings.csv'
    : 'rpp_downloads/rpp_item_keyword_real.csv';
  const settingsPath = path.join(PROJECT, arg('settings', defaultSettings));
  const itemSettingsPath = path.join(PROJECT, arg('item-settings', 'rpp_item_settings.csv'));
  const perfPath = path.join(PROJECT, arg('perf', 'rpp_keyword_reports.csv'));
  const itemPerfPath = path.join(PROJECT, arg('item-perf', 'rpp_item_reports.csv'));
  const excludePath = path.join(PROJECT, arg('exclude', 'rpp_exclude_items.csv'));
  const notify = process.argv.includes('--notify');
  const { getOutPath, emit } = require('./rpp_notify_out');
  const { latestPositionMap, formatPositionInfo } = require('./rpp_position_data');
  const outPath = getOutPath();

  log('=== RPP CPCアドバイザー 開始 ===');
  log(`設定CSV: ${path.relative(PROJECT, settingsPath)}`);

  const keywordSettings = loadSettings(settingsPath);
  const itemSettings = loadItemSettings(itemSettingsPath);
  const settings = [...itemSettings, ...keywordSettings];
  const productCpcRows = itemSettings.length;
  log(`登録キーワード/商品CPC行: ${settings.length} 件（商品CPC ${productCpcRows}件 / キーワード ${keywordSettings.length}件）`);

  const keywordPerfMap = loadPerformance(perfPath);
  const itemPerfMap = loadItemPerformance(itemPerfPath);
  const productPerfMap = buildProductCpcPerformance(itemPerfMap, keywordPerfMap);
  const perfMap = new Map([...keywordPerfMap.entries(), ...productPerfMap.entries()]);
  log(`実績データ: キーワード ${keywordPerfMap.size} 件 / 商品別 ${itemPerfMap.size} 件 / 商品CPC推定 ${productPerfMap.size} 件`);

  // RMSの除外商品（広告停止中）はCPC提案の対象から分離する
  const rmsExclude = loadExcludeList(excludePath);
  log(`RMS除外商品リスト: ${rmsExclude.size} 件（${fs.existsSync(excludePath) ? path.relative(PROJECT, excludePath) : 'なし → node rpp_exclude_downloader.js で取得できます'}）`);

  // 保護ルール: 設定ファイルの除外商品・除外キーワードも対象から外す
  const g = CONFIG.guard;
  const active = [];
  const excluded = [];
  for (const s of settings) {
    if (g.excludeItemCodes.includes(s.itemCode) || g.excludeKeywords.includes(s.keyword)) continue;
    if (s.settingExcluded || rmsExclude.has(s.itemCode)) excluded.push(s);
    else active.push(s);
  }
  if (excluded.length > 0) {
    log(`→ 除外商品に登録中のキーワード ${excluded.length} 件は提案対象外（広告停止中のため）`);
  }

  const { down, under, ok } = analyze(active, perfMap);

  const stamp = new Date().toLocaleDateString('sv-SE').replace(/-/g, '');
  const reportPath = path.join(PROJECT, `rpp_cpc_report_${stamp}.csv`);
  writeReport(down, under, ok, excluded, reportPath);

  log('');
  log(`【結果】`);
  log(`  ①下げ候補（設定CPC > 目安CPC）: ${down.length} 件`);
  log(`  ②推奨未達（設定CPC < 目安CPC）: ${under.length} 件`);
  log(`  ③目安どおり: ${ok.length} 件`);
  log(`  ④除外中（広告停止・提案対象外）: ${excluded.length} 件`);
  log('');

  if (down.length > 0) {
    log('--- ①下げ候補（下げ幅の大きい順） ---');
    for (const r of down.slice(0, 20)) {
      log(`  [${r.itemCode}] "${r.keyword}" ${r.current}円 → ${r.proposed}円（目安${r.meyasu}円 / ${r.source}）`);
    }
    const upDir = path.join(PROJECT, 'rpp_uploads');
    fs.mkdirSync(upDir, { recursive: true });
    const now = new Date();
    const hm = `${stamp}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const uploadPath = path.join(upDir, `cpc_down_${hm}.csv`);
    writeUploadCsv(down, uploadPath);
    log(`  → 一括アップロード用CSVを生成: ${path.relative(PROJECT, uploadPath)}（※アップロードはしていません）`);
  }

  if (under.length > 0) {
    log('--- ②推奨未達（クリック数が多い順・上位15件） ---');
    for (const r of under.slice(0, 15)) {
      const perfNote = r.perf ? `クリック${r.perf.clicks} 実績¥${r.perf.spend}` : '前日レポートに該当KWなし';
      log(`  [${r.itemCode}] "${r.keyword}" ${r.current}円（目安${r.meyasu}円・あと${r.gap}円）${perfNote}`);
    }
  }

  log('');
  log(`上司さん確認用レポート: ${path.basename(reportPath)}（Excelで開けます）`);

  if (notify || outPath) {
    const { sendChatwork } = require('./chatwork_notify');
    const { displayName } = require('./rpp_display_names');
    const active = down.length + under.length + ok.length;

    const roasBar = loadRoasBar();

    // 位置データを読む（あれば）
    const positionMap = latestPositionMap();

    // 通知はスマホで見やすいよう、商品ごとに指標を縦並びにする。維持候補は出さない。
    const fmtYen = (v) => v == null ? '-' : `${Math.round(v).toLocaleString()}円`;
    const rppBrief = (info) => {
      const one = (v) => {
        if (!v) return '-';
        if (v.rppAdPosition == null) return v.hasRppSlot === false ? '広告枠なし' : '1ページ目にいない';
        return `1ページ目内 ${v.rppAdPosition}位`;
      };
      if (!info) return { pc: '未測定', sp: '未測定' };
      return { pc: one(info.pc || info.PC || info), sp: one(info.mobile || info.sp || {}) };
    };
    const perfLines = (r) => {
      const p = r.perf;
      if (!p) return ['　実績　: 前日レポートに該当KWなし'];
      return [
        `　実績　: クリック ${p.clicks ?? 0} / 費用 ${fmtYen(p.spend)} / 売上 ${fmtYen(p.salesAmount)}`,
        `　効率　: ROAS ${p.roas != null ? `${Math.round(p.roas)}%` : '-'} / CVR ${p.cvr != null ? `${p.cvr}%` : '-'}`,
      ];
    };
    const posNum = (v) => {
      const m = String(v || '').match(/(?:1ページ目内\s*)?(\d+)位$/);
      return m ? Number(m[1]) : null;
    };
    const decisionOf = (r, kind, rp) => {
      const pc = posNum(rp.pc), sp = posNum(rp.sp);
      const best = Math.min(pc ?? 999, sp ?? 999);
      const onTarget = best <= 5;
      const inFirstPage = best < 999;
      const roas = r.perf?.roas;
      const profitable = roas != null && roas >= roasBar;
      if (kind === 'up') {
        if (onTarget && !profitable) return '維持（RPP広告1ページ目内・5位以内／ROAS採算未満）';
        if (onTarget) return '維持寄り（RPP広告1ページ目内・5位以内）';
        if (inFirstPage) return '要確認（RPP広告は1ページ目内・5位外）';
        if (profitable) return '上げ検討（RPP広告が1ページ目にいない・ROAS良好）';
        return '上げ慎重（RPP広告1ページ目外/採算を確認）';
      }
      if (profitable) return '下げ慎重（ROAS良好）';
      return '下げ検討（目安超え・採算確認）';
    };
    const row = (r, kind) => {
      const nm = displayName(r.itemCode, r.itemName);
      const kw = r.keyword === nm ? '' : `KW: ${r.keyword}${r.representativeKeyword ? '（代表KW）' : ''}`;
      const arrow = kind === 'down'
        ? `${r.current}円 → ${r.proposed ?? r.meyasu}円`
        : `${r.current}円 → 目安${r.meyasu}円`;
      const posKey = `${r.itemCode}\t${r.keyword}`;
      const rp = rppBrief(positionMap[posKey]);
      const lines = [
        `・${nm} ${r.itemCode}`,
        kw ? `　KW　　: ${r.keyword}${r.representativeKeyword ? '（代表KW）' : ''}` : null,
        `　判定　: ${decisionOf(r, kind, rp)}`,
        `　CPC　 : ${arrow}`,
        `　順位　: RPP PC ${rp.pc} / スマホ ${rp.sp}（1ページ目内かを重視。5位以内は基本OK）`,
        ...perfLines(r),
      ].filter(Boolean);
      return lines.join('\n');
    };
    const list = (arr, kind, max = 5) => {
      const head = arr.slice(0, max).map(r => row(r, kind)).join('\n\n');
      return arr.length > max ? `${head}\n\n・ほか${arr.length - max}件` : head;
    };

    let msg = `目安未満: ${under.length} / 目安超え: ${down.length}\n`;
    msg += `※目安未満=自動で上げる意味ではありません。RPP広告が1ページ目内なら基本維持、1ページ目にいない時だけ上げ検討。\n`;
    if (under.length) msg += `▼目安未満（上げるかは順位/ROASで判断）\n${list(under, 'up')}\n`;
    if (down.length) msg += `▼目安超え（下げるか確認）\n${list(down, 'down')}\n`;
    if (!under.length && !down.length) msg += `CPCは要対応なし\n`;

    const sm = [];
    if (under.length) sm.push(`CPC目安未満${under.length}`);
    if (down.length) sm.push(`CPC目安超え${down.length}`);
    const r = await emit(msg, () => sendChatwork(msg, CONFIG.chatwork.roomId || undefined), { summary: sm.join('・') });
    log(r.mode === 'file'
      ? `通知本文を書き出し: ${path.relative(PROJECT, r.path)}（まとめ送信に回します）`
      : 'Chatwork通知 送信');
  }

  log('=== 正常終了 ===');
}

if (require.main === module) main().catch(e => { console.error(`❌ エラー: ${e.message}`); process.exitCode = 1; });

module.exports = { analyze, loadSettings, loadItemSettings, loadPerformance, loadItemPerformance, buildProductCpcPerformance };
