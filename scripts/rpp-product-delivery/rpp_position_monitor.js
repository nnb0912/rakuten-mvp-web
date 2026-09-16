#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const SHOP = process.env.SHOP_URL || 'auc-risecreation';
const SHOP_ID = process.env.RAKUTEN_SHOP_ID || '307271'; // auc-risecreation / atRise
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const DEFAULT_TARGETS = [
  ['r0606', 'まな板'], ['c0144', 'クーラーボックス'], ['r0550', 'ブラケットライト'],
  ['r0681', 'キッチン 収納 調味料'], ['r0681', 'キッチン 調味料ラック 収納'],
  ['r0867', 'アイスボール シリコン'], ['r0399', 'ソープディスペンサー 泡'],
  ['r0579', 'バスラック'], ['r0695', 'タワシート'], ['r0700', '電子レンジ調理器'],
  ['r0886', 'コンロ 隙間 テープ'],
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const arg = (name, def = null) => {
  const p = process.argv.find(a => a.startsWith(`--${name}=`));
  return p ? p.split('=', 2)[1] : def;
};

function loadTargets() {
  const file = arg('targets');
  if (!file) return DEFAULT_TARGETS.map(([itemCode, keyword]) => ({ itemCode, keyword }));
  const rows = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const sourceRows = Array.isArray(rows) ? rows : (rows.targets || []);
  return sourceRows.flatMap(r => {
    const base = Array.isArray(r) ? ({ itemCode: r[0], keyword: r[1] }) : r;
    const searchKeywords = Array.isArray(base.searchKeywords) && base.searchKeywords.length ? base.searchKeywords : [base.searchKeyword || base.keyword];
    return searchKeywords.filter(Boolean).map(searchKeyword => ({ ...base, sourceKeyword: base.keyword, keyword: searchKeyword }));
  });
}

async function extract(page, itemCode) {
  return page.evaluate(({ shop, rakutenShopId, itemCode }) => {
    const norm = s => (s || '').toLowerCase().replace(/\/$/, '');
    const selfCode = norm(itemCode);
    const shopSlugTarget = shop;
    const shopIdTarget = rakutenShopId;
    const codeMatches = code => {
      const c = norm(code);
      return c === selfCode || c.startsWith(`${selfCode}-`);
    };
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const isVisible = el => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const productLink = el => {
      let links = [...el.querySelectorAll('a[href*="item.rakuten.co.jp/"]')];
      if (el.matches && el.matches('a[href*="item.rakuten.co.jp/"]')) links.unshift(el);
      for (const a of links) {
        const m = (a.href || '').match(/item\.rakuten\.co\.jp\/([^/]+)\/([^/?#]+)/i);
        if (m) return { a, shop: m[1], code: norm(decodeURIComponent(m[2])) };
      }
      // スマホRPP枠ではhrefが遅延生成されず、data-shop-id/data-track-variantidだけあることがある。
      const shopId = el.getAttribute('data-shop-id');
      const variant = el.getAttribute('data-track-variantid');
      const itemid = el.getAttribute('data-track-itemid');
      if (shopId && (variant || itemid)) {
        const code = norm(decodeURIComponent(variant || String(itemid).split('/').pop()));
        return { a: el, shop: shopId === shopIdTarget ? shopSlugTarget : shopId, code };
      }
      return null;
    };
    const cardIsPr = card => {
      const text = clean(card.innerText || '');
      const attrs = Object.fromEntries([...card.attributes || []].map(x => [x.name, x.value]));
      const attrText = Object.entries(attrs).map(([k, v]) => `${k}=${v}`).join(' ');
      // data-rpp-links-overrides / data-rpp-url-copy は自然検索カードにも付くためPR扱いしない。
      // RPP広告は data-track-rpp:* か、商品カード内の明示PRラベルだけで判定する。
      if (/data-track-rpp:/i.test(attrText)) return true;
      if (attrs['data-card-type'] && /rpp|ad|pr|cpc/i.test(attrs['data-card-type'])) return true;
      if (attrs['data-track-type'] && /rpp|ad|pr|cpc/i.test(attrs['data-track-type'])) return true;
      if (attrs['data-track-doc-type'] && /rpp|ad|pr|cpc/i.test(attrs['data-track-doc-type'])) return true;
      return /(^|\s|\[)PR(\]|\s|$)/.test(text.slice(0, 500));
    };

    // 楽天PC/スマホ検索の商品カード本体。anchor単位だと画像リンク/タイトルリンクで二重計上するため禁止。
    let cardNodes = [...document.querySelectorAll('.dui-card.searchresultitem, .dui-item.searchresultitem, [data-track-card="search"][data-track-type="item"], [data-track-card="search"][data-track-type="cpc"]')]
      // スクロール後やスマホDOMではカードが現在viewport外でも1ページ目DOMに存在するため、visibilityで落とさない。
      .filter(el => productLink(el));

    // fallback: card selectorで拾えないPRカルーセル/新DOMも、商品リンクから商品カード単位で拾う。
    // 既存カードがある場合でも追加する。楽天検索上部のPR枠だけDOM構造が違うケースがあるため。
    const seenEl = new Set(cardNodes);
    for (const a of [...document.querySelectorAll('a[href*="item.rakuten.co.jp/"]')].filter(isVisible)) {
      let best = a;
      for (let el = a; el && el !== document.body; el = el.parentElement) {
        const t = clean(el.innerText || '');
        if (t.length > 80) best = el;
        if ((el.getAttribute('data-track-card') === 'search' && /item|cpc/.test(el.getAttribute('data-track-type') || '')) || String(el.className).includes('searchresultitem')) { best = el; break; }
      }
      const overlapsExisting = cardNodes.some(card => card === best || card.contains(best) || best.contains(card));
      if (!overlapsExisting && !seenEl.has(best)) { seenEl.add(best); cardNodes.push(best); }
    }

    const raw = [];
    for (const card of cardNodes) {
      const link = productLink(card);
      if (!link) continue;
      const r = card.getBoundingClientRect();
      raw.push({
        shop: link.shop,
        code: link.code,
        top: Math.round(r.top),
        left: Math.round(r.left),
        isPr: cardIsPr(card),
        text: clean(card.innerText || link.a.innerText).slice(0, 140),
      });
    }
    raw.sort((a, b) => (a.top - b.top) || (a.left - b.left));
    // cardNodes are already product-card units. Do not de-dupe by item code: the same item can appear once in RPP and once in organic.
    const cards = raw;
    const bodyHasPrLabel = /(^|\s|\[)PR(\]|\s|$)/.test(clean(document.body.innerText || ''));

    let organic = 0, rpp = 0;
    let found = null;
    const hasRppSlot = cards.some(c => c.isPr) || bodyHasPrLabel;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      if (c.isPr) rpp += 1; else organic += 1;
      if (c.shop === shop && codeMatches(c.code)) {
        if (!found) found = { screenPosition: i + 1, organicPosition: null, rppAdPosition: null, isPr: c.isPr, sampleText: c.text };
        if (c.isPr) found.rppAdPosition = rpp;
        else found.organicPosition = organic;
      }
    }
    if (found) {
      return {
        ...found,
        hasRppSlot,
        cardsParsed: cards.length,
        prCardsParsed: cards.filter(x => x.isPr).length,
        firstCards: cards.slice(0, 10).map(x => ({ shop: x.shop, code: x.code, isPr: x.isPr, text: x.text.slice(0, 60) })),
      };
    }
    return { screenPosition: null, organicPosition: null, rppAdPosition: null, isPr: null, hasRppSlot, cardsParsed: cards.length, prCardsParsed: cards.filter(x => x.isPr).length, firstCards: cards.slice(0, 10).map(x => ({ shop: x.shop, code: x.code, isPr: x.isPr, text: x.text.slice(0, 60) })) };
  }, { shop: SHOP, rakutenShopId: SHOP_ID, itemCode });
}

async function newIsolatedPage(browser) {
  // 楽天検索はログイン済み/RMSプロファイルだとPR枠が非表示になり、広告枠なしに誤判定することがある。
  // 検索順位測定は未ログインの新規コンテキストで分離して、一般ユーザー向けのPR枠を測る。
  const context = browser.createBrowserContext
    ? await browser.createBrowserContext()
    : (browser.createIncognitoBrowserContext ? await browser.createIncognitoBrowserContext() : null);
  const page = context ? await context.newPage() : await browser.newPage();
  return { page, context };
}

async function measureOne(browser, target, device) {
  const { page, context } = await newIsolatedPage(browser);
  try {
    if (device === 'mobile') {
      await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1');
      await page.setViewport({ width: 390, height: 1200, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    } else {
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36');
      await page.setViewport({ width: 1365, height: 2200, isMobile: false, deviceScaleFactor: 1 });
    }
    const url = `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(target.keyword)}/`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await sleep(Number(process.env.RPP_RENDER_WAIT_MS || 5000));
    // RPP枠はページ上部にJS差し込みされるため、スクロールでDOMが差し替わる前の上部DOMを測る。
    const res = await extract(page, target.itemCode);
    res.url = url;
    return res;
  } finally {
    await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

async function main() {
  const targets = loadTargets();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const results = [];
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    const row = { itemCode: target.itemCode, keyword: target.keyword, sourceKeyword: target.sourceKeyword || target.keyword, targetId: target.targetId, owner: target.owner, searchKeywords: target.searchKeywords };
    try { row.pc = await measureOne(browser, target, 'pc'); } catch (e) { row.pc = { error: String(e) }; }
    try { row.mobile = await measureOne(browser, target, 'mobile'); } catch (e) { row.mobile = { error: String(e) }; }
    results.push(row);
    if (i < targets.length - 1) {
      const minPause = Math.max(0, Number(process.env.RPP_TARGET_PAUSE_MIN_MS || 0));
      const maxPause = Math.max(minPause, Number(process.env.RPP_TARGET_PAUSE_MAX_MS || minPause));
      if (maxPause > 0) await sleep(Math.round(minPause + Math.random() * (maxPause - minPause)));
    }
  }
  await browser.close();
  const out = JSON.stringify(results, null, 2);
  const outPath = arg('out');
  if (outPath) fs.writeFileSync(path.resolve(outPath), out);
  else console.log(out);
}

main().catch(e => { console.error(e); process.exit(1); });
