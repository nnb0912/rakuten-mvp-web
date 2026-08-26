#!/usr/bin/env node
/** RPP exclusion CSV upload helper for RMS using Node Playwright. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

function argValue(name) {
  const prefix = `${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
}
function hasArg(name) { return process.argv.includes(name); }

function parseCsv(csvPath) {
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);
  let text = fs.readFileSync(csvPath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const parseLine = (line) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i += 1; }
        else quoted = !quoted;
      } else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((v) => v.trim());
  };
  const header = parseLine(lines[0]);
  const idxControl = header.indexOf('コントロールカラム');
  const idxCode = header.indexOf('商品管理番号');
  if (idxControl < 0 || idxCode < 0) throw new Error(`CSV header invalid: ${header.join(',')}`);
  return lines.slice(1).map(parseLine).map((cols) => ({
    control: cols[idxControl] || '',
    itemCode: cols[idxCode] || '',
  })).filter((row) => row.itemCode);
}
function emit(obj) { console.log(JSON.stringify(obj, null, 2)); }

async function searchExclusionStatus(page, itemCode) {
  await page.goto('https://ad.rms.rakuten.co.jp/rpp/exclude', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  const searchInput = page.locator('input[placeholder="商品管理番号"], input[name*="item"], input[type="text"]').first();
  if (await searchInput.count()) {
    await searchInput.fill(itemCode);
    const searchButton = page.locator('#btnSearchExcludeItem, button:has-text("検索"), input[value="検索"]').first();
    if (await searchButton.count()) await searchButton.click({ timeout: 5000 }).catch(async () => searchButton.evaluate((el) => el.click()));
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
  }
  const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
  const found = text.toLowerCase().includes(itemCode.toLowerCase()) && !text.includes('0件');
  return { itemCode, found, textSample: text.replace(/[\r\n]+/g, ' ').slice(0, 500) };
}

async function loginAndUpload(csvPath, rows, finalSubmit) {
  const required = ['RMS_LOGIN_ID', 'RMS_LOGIN_PASS', 'RAKUTEN_EMAIL', 'RAKUTEN_EMAIL_PASS'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`RMS credentials missing on server: ${missing.join(', ')}`);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ acceptDownloads: true, locale: 'ja-JP' });
  const page = await context.newPage();
  try {
    page.on('dialog', async (dialog) => {
      await dialog.accept().catch(() => undefined);
    });

    await page.goto(process.env.RMS_LOGIN_URL || 'https://glogin.rms.rakuten.co.jp/?sp_id=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    if (await page.locator('input[name="login_id"]').count()) {
      await page.fill('input[name="login_id"]', process.env.RMS_LOGIN_ID || '');
      await page.fill('input[name="passwd"]', process.env.RMS_LOGIN_PASS || '');
      const btn = page.locator('button:has-text("楽天会員ログイン"), button:has-text("楽天会員ログインへ"), input[value*="楽天会員ログイン"]');
      if (await btn.count()) await btn.first().click();
      await page.waitForTimeout(3000);
    }
    if (await page.locator('#user_id').count()) {
      await page.fill('#user_id', process.env.RAKUTEN_EMAIL || '');
      await page.locator('#cta001').click();
      await page.waitForTimeout(4000);
    }
    if (await page.locator('#password_current').count()) {
      await page.fill('#password_current', process.env.RAKUTEN_EMAIL_PASS || '');
      await page.locator('#cta011').click();
      await page.waitForTimeout(6000);
    }
    for (let i = 0; i < 4; i += 1) {
      const nextBtn = page.locator('a:has-text("次へ"), button:has-text("次へ"), input[value="次へ"]');
      if (await nextBtn.count()) { await nextBtn.first().click(); await page.waitForTimeout(3000); }
      else break;
    }
    const compliance = page.locator('a:has-text("遵守"), button:has-text("遵守"), input[value*="遵守"]');
    if (await compliance.count()) { await compliance.first().click(); await page.waitForTimeout(5000); }

    await page.goto('https://mainmenu.rms.rakuten.co.jp/?act=login&sp_id=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    await page.goto('https://ad.rms.rakuten.co.jp/rpp/exclude', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    const body = await page.evaluate(() => document.body.innerText.slice(0, 2000));
    if (body.includes('システムエラー') || (body.includes('ログイン') && !body.includes('除外'))) {
      throw new Error(`RMS login not completed; exclusion upload aborted; url=${page.url()}; title=${await page.title()}; body=${body.replace(/[\r\n]+/g, ' ').slice(0, 600)}`);
    }

    let openedBulkUpload = false;
    const bulkButton = page.locator('#btnBulkUploadExcludeItemOpenModal');
    if (await bulkButton.count()) { await bulkButton.first().click({ timeout: 5000 }); openedBulkUpload = true; await page.waitForTimeout(1500); }
    if (!openedBulkUpload) {
      for (const text of ['一括アップロード', 'アップロード']) {
        const loc = page.getByText(text, { exact: false }).first();
        if (await loc.count() && await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
          await loc.click({ timeout: 5000 }); openedBulkUpload = true; await page.waitForTimeout(1500); break;
        }
      }
    }
    const fileInput = page.locator('input[type="file"]').first();
    if ((await fileInput.count()) === 0) throw new Error('RMS exclusion upload file input not found');
    await fileInput.setInputFiles(csvPath);
    await page.waitForTimeout(1000);
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      fileValue: document.querySelector('input[type="file"]')?.value || '',
      buttons: [...document.querySelectorAll('button,input[type="button"],input[type="submit"],a')]
        .map((e) => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim())
        .filter(Boolean)
        .slice(0, 35),
    }));
    if (!finalSubmit) return { fileSelected: true, finalSubmitSkipped: true, openedBulkUpload, ...info };

    let uploadClicked = false;
    const primaryUpload = page.locator('#btnUploadFile').first();
    if (await primaryUpload.count()) {
      await primaryUpload.evaluate((el) => el.click());
      uploadClicked = true;
    }
    if (!uploadClicked) {
      for (const selector of ['input[type="submit"]', 'button']) {
        const candidates = page.locator(selector);
        const count = await candidates.count();
        for (let i = 0; i < Math.min(count, 20); i += 1) {
          const el = candidates.nth(i);
          const label = ((await el.innerText({ timeout: 1000 }).catch(() => '')) || (await el.getAttribute('value')) || '').trim();
          if (['アップロード', '登録', '反映', '実行'].some((s) => label.includes(s))) {
            await el.evaluate((node) => node.click()); uploadClicked = true; break;
          }
        }
        if (uploadClicked) break;
      }
    }
    if (!uploadClicked) throw new Error('RMS final upload button not found');
    for (let step = 0; step < 3; step += 1) {
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
      await page.waitForTimeout(3000);
      const confirm = page.locator('button:has-text("登録"), button:has-text("実行"), button:has-text("OK"), button:has-text("はい"), input[value*="登録"], input[value*="実行"], input[value*="OK"]').first();
      const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
      if (/完了|登録しました|登録されました|受け付けました|アップロードしました|成功/.test(text)) break;
      if (await confirm.count() && await confirm.isVisible({ timeout: 1000 }).catch(() => false)) {
        await confirm.evaluate((node) => node.click());
        continue;
      }
      break;
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(5000);
    const pageTextSample = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    const failureText = pageTextSample.match(/[^\n]*(失敗|エラー|不正|登録できません|アップロードできません)[^\n]*/g)?.slice(0, 8) || [];
    const readback = [];
    for (const row of rows) readback.push(await searchExclusionStatus(page, row.itemCode));
    const readbackFailures = readback.filter((row, idx) => (rows[idx].control === 'n' && !row.found) || (rows[idx].control === 'd' && row.found));
    if (failureText.length || readbackFailures.length) {
      throw new Error(`RMS upload verification failed: ${[...failureText, ...readbackFailures.map((row) => `${row.itemCode} readback=${row.found}`)].join(' / ')}`);
    }
    return { fileSelected: true, finalSubmitClicked: true, pageTextSample, readback, ...info };
  } finally {
    await browser.close();
  }
}

async function main() {
  const csvArg = argValue('--csv');
  if (!csvArg) throw new Error('--csv is required');
  const csvPath = path.resolve(csvArg);
  const rows = parseCsv(csvPath);
  const base = { ok: true, productionChange: false, uploadCsv: csvPath, rowCount: rows.length, rows };
  if (!rows.length) { emit({ ...base, skipped: true, reason: 'rows are 0' }); return; }
  if (!hasArg('--execute')) { emit({ ...base, dryRun: true, reason: 'missing --execute' }); return; }
  if (process.env.RPP_ENABLE_RMS_EXCLUSION_UPLOAD !== '1') throw new Error('RPP_ENABLE_RMS_EXCLUSION_UPLOAD=1 is required');
  const finalSubmit = hasArg('--final-submit');
  if (finalSubmit && argValue('--confirm') !== 'RMS_EXCLUSION_UPLOAD') throw new Error('--confirm=RMS_EXCLUSION_UPLOAD is required for final submit');
  const applied = await loginAndUpload(csvPath, rows, finalSubmit);
  emit({ ...base, productionChange: finalSubmit, applied });
}
main().catch((e) => { console.error(`❌ エラー: ${e?.message || e}`); process.exit(1); });
