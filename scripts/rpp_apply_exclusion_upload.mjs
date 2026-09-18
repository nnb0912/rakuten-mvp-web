#!/usr/bin/env node
/** RPP exclusion CSV upload helper for RMS using Node Playwright. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function treeSha256(root) {
  if (!fs.statSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
    throw new Error('runtime dependency tree is missing or unsafe');
  }
  const digest = createHash('sha256');
  const resolvedRoot = fs.realpathSync(root);
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(absolute);
        const relativeTarget = path.relative(resolvedRoot, target);
        if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
          throw new Error('runtime dependency symlink escapes immutable root');
        }
        digest.update(Buffer.from(`${relative}\0L${fs.readlinkSync(absolute)}\0`));
      } else if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        const fileDigest = createHash('sha256').update(fs.readFileSync(absolute)).digest();
        digest.update(Buffer.from(`${relative}\0F`));
        digest.update(fileDigest);
        digest.update(Buffer.from('\0'));
      }
    }
  };
  walk(root);
  return digest.digest('hex');
}

function attestedPlaywright() {
  const nodeRoot = path.resolve(process.env.RPP_PLAYWRIGHT_NODE_ROOT || '');
  const browserRoot = path.resolve(process.env.RPP_CHROMIUM_BUNDLE_ROOT || '');
  const executablePath = path.resolve(process.env.RPP_CHROMIUM_EXECUTABLE || '');
  const nodeHash = process.env.RPP_PLAYWRIGHT_TREE_SHA256 || '';
  const browserHash = process.env.RPP_CHROMIUM_TREE_SHA256 || '';
  if (!nodeRoot || !browserRoot || !executablePath || !/^[0-9a-f]{64}$/.test(nodeHash) || !/^[0-9a-f]{64}$/.test(browserHash)) {
    throw new Error('attested Playwright runtime is required');
  }
  const relativeExecutable = path.relative(browserRoot, executablePath);
  if (!relativeExecutable || relativeExecutable.startsWith('..') || path.isAbsolute(relativeExecutable)) {
    throw new Error('Chromium executable is outside the attested bundle');
  }
  if (treeSha256(nodeRoot) !== nodeHash || treeSha256(browserRoot) !== browserHash) {
    throw new Error('Playwright or Chromium runtime digest mismatch');
  }
  const playwrightPackage = path.join(nodeRoot, 'playwright', 'package.json');
  const runtimeRequire = createRequire(playwrightPackage);
  const { chromium } = runtimeRequire(path.join(nodeRoot, 'playwright'));
  return { chromium, executablePath };
}

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
  const buffer = fs.readFileSync(csvPath);
  const decodeCandidates = [
    () => new TextDecoder('utf-8').decode(buffer),
    () => new TextDecoder('shift_jis').decode(buffer),
  ];
  let text = '';
  let lines = [];
  for (const decode of decodeCandidates) {
    text = decode();
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (lines[0]?.includes('コントロールカラム') && lines[0]?.includes('商品管理番号')) break;
  }
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

function requirePageOrigin(page, allowed, stage) {
  const origin = new URL(page.url()).origin;
  if (!allowed.includes(origin)) throw new Error(`${stage} origin is not allowed: ${origin}`);
}

async function fillCredentialAtOrigin(locator, expectedOrigin, value, stage) {
  await locator.evaluate((element, args) => {
    if (location.origin !== args.expectedOrigin) throw new Error(`${args.stage} origin changed before credential fill`);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error(`${args.stage} input setter unavailable`);
    setter.call(element, args.value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, { expectedOrigin, value, stage });
}

function validateWalBinding(walPath, operationId, csvPath, csvBuffer, rows, expectedPhase = 'PREPARED') {
  const payload = JSON.parse(fs.readFileSync(walPath, 'utf8'));
  const digest = createHash('sha256').update(csvBuffer).digest('hex');
  const normalizedRows = rows.map(({ control, itemCode }) => ({ control, itemCode }));
  if (payload.operationId !== operationId || payload.phase !== expectedPhase) throw new Error('WAL operation/phase mismatch');
  if (path.resolve(String(payload.csvPath || '')) !== csvPath
      || payload.csvSha256 !== digest || payload.csvBytes !== csvBuffer.length
      || JSON.stringify(payload.csvRows) !== JSON.stringify(normalizedRows)) {
    throw new Error('WAL CSV payload binding mismatch');
  }
  return payload;
}

function requireRuntimeActivation(walPath, operationId) {
  const payload = JSON.parse(fs.readFileSync(walPath, 'utf8'));
  const runtimeCommit = process.env.RPP_RUNTIME_COMMIT || '';
  if (payload.operationId !== operationId || !runtimeCommit || payload.runtimeCommit !== runtimeCommit) {
    throw new Error('runtime commit binding mismatch');
  }
  const activationPath = process.env.RPP_ACTIVATION_RECEIPT
    || '/Users/nob/Projects/rpp-8am-notify/rpp_apply_logs/rpp_product_delivery_dispatcher_activation.json';
  const activation = JSON.parse(fs.readFileSync(activationPath, 'utf8'));
  if (activation.activated !== true || activation.activationHold === true
      || activation.circuitProbePassed !== true || activation.commit !== runtimeCommit) {
    throw new Error('runtime activation is not valid');
  }
  const service = `gui/${process.getuid()}/com.rise.rpp-product-delivery-dispatcher`;
  const loaded = execFileSync('/bin/launchctl', ['print', service], { encoding: 'utf8', timeout: 5000 });
  const pidMatch = loaded.match(/^\s*pid\s*=\s*(\d+)\s*$/m);
  const stateMatch = loaded.match(/^\s*state\s*=\s*(\S+)\s*$/m);
  const programMatch = loaded.match(/^\s*program\s*=\s*(.+?)\s*$/m);
  const expectedArguments = ['/usr/bin/python3', '-s', '/Users/nob/Projects/rpp-8am-notify/deploy_worker_runtime.py', '--run-scheduler-dispatcher'];
  const argumentBlock = loaded.match(/^\s*arguments\s*=\s*\{(.*?)^\s*\}/ms);
  const argumentsLoaded = argumentBlock ? argumentBlock[1].split('\n').map((line) => line.trim().replace(/^\d+\s*=\s*/, '')).filter(Boolean) : [];
  const environmentBlock = loaded.match(/^\s*environment\s*=\s*\{(.*?)^\s*\}/ms);
  const environment = {};
  for (const line of environmentBlock?.[1]?.split('\n') || []) {
    const match = line.trim().match(/^([^=]+?)\s*=>\s*(.*)$/);
    if (match) environment[match[1].trim()] = match[2].trim();
  }
  const expectedEnvironment = { HOME: '/Users/nob', PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    RPP_PROJECT_DIR: '/Users/nob/Projects/rpp-8am-notify', RPP_EVENT_DISPATCHER: '1', PYTHONNOUSERSITE: '1' };
  if (programMatch?.[1] !== expectedArguments[0] || JSON.stringify(argumentsLoaded) !== JSON.stringify(expectedArguments)
      || stateMatch?.[1] !== 'running' || !pidMatch
      || JSON.stringify(environment) !== JSON.stringify(expectedEnvironment)
      || activation.dispatcherPid !== Number(pidMatch[1])) {
    throw new Error('runtime activation is not bound to the attested live dispatcher');
  }
}

function updateWalPhase(walPath, operationId, expectedPhase, phase, csvPath, csvBuffer, rows) {
  const payload = validateWalBinding(walPath, operationId, csvPath, csvBuffer, rows, expectedPhase);
  payload.phase = phase;
  payload.phaseUpdatedAt = new Date().toISOString();
  if (phase === 'SUBMITTED') payload.submittedAt = payload.phaseUpdatedAt;
  const temporary = `${walPath}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, walPath);
  const dirFd = fs.openSync(path.dirname(walPath), 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

async function searchExclusionStatus(page, itemCode) {
  await page.goto('https://ad.rms.rakuten.co.jp/rpp/exclude', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  requirePageOrigin(page, ['https://ad.rms.rakuten.co.jp'], 'RMS exclusion readback');
  const searchInput = page.locator('input[placeholder="商品管理番号"], input[name*="item"]').first();
  if ((await searchInput.count()) === 0) throw new Error('RMS exclusion item-code search input not found');
  await searchInput.fill(itemCode);
  const searchButton = page.locator('#btnSearchExcludeItem, button:has-text("検索"), input[value="検索"]').first();
  if ((await searchButton.count()) === 0) throw new Error('RMS exclusion search button not found');
  await searchButton.click({ timeout: 5000 }).catch(async () => searchButton.evaluate((el) => el.click()));
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  const status = await page.evaluate((code) => {
    const normalized = String(code).trim().toLowerCase();
    const text = document.body.innerText;
    let headerFound = false;
    const exactRows = [];
    for (const table of document.querySelectorAll('table')) {
      const headers = [...table.querySelectorAll('thead th, tr:first-child th')].map((cell) => cell.innerText.trim());
      const codeIndex = headers.findIndex((header) => header.includes('商品管理番号'));
      if (codeIndex < 0) continue;
      headerFound = true;
      for (const tr of table.querySelectorAll('tbody tr')) {
        const cells = [...tr.querySelectorAll('td')];
        if (cells[codeIndex]?.innerText.trim().toLowerCase() === normalized) exactRows.push(tr.innerText.replace(/[\r\n]+/g, ' ').trim());
      }
    }
    return { text, headerFound, exactRows };
  }, itemCode);
  if (!status.headerFound) throw new Error('RMS exclusion item-code column not found');
  if (status.exactRows.length > 1) throw new Error(`RMS exclusion duplicate exact rows: ${itemCode}`);
  const found = status.exactRows.length === 1;
  return { itemCode, found, exactRows: status.exactRows.slice(0, 5), textSample: status.text.replace(/[\r\n]+/g, ' ').slice(0, 500) };
}

export function acquireProfileLock(profileDir) {
  const lockPath = path.join(profileDir, '.rpp-adapter.lock');
  const create = () => {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    fs.fsyncSync(fd);
    return { fd, lockPath };
  };
  try {
    return create();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { /* invalid lock is stale */ }
    let alive = false;
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); alive = true; } catch (killError) { alive = killError?.code === 'EPERM'; }
    }
    if (alive) throw new Error(`RMS adapter profile is locked by pid ${owner.pid}`);
    fs.rmSync(lockPath, { force: true });
    return create();
  }
}

export function releaseProfileLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } finally { fs.rmSync(lock.lockPath, { force: true }); }
}

export async function pollExactReadback(page, rows, options = {}) {
  const configured = Number.parseInt(process.env.RPP_RMS_READBACK_TIMEOUT_MS || '180000', 10);
  const timeoutMs = Math.max(0, Math.min(180000, options.timeoutMs ?? (Number.isFinite(configured) ? configured : 180000)));
  const intervalMs = Math.max(1, options.intervalMs ?? 10000);
  const search = options.search || searchExclusionStatus;
  const sleep = options.sleep || ((milliseconds) => page.waitForTimeout(milliseconds));
  const deadline = Date.now() + timeoutMs;
  let readback = [];
  do {
    readback = [];
    for (const row of rows) readback.push(await search(page, row.itemCode));
    const failures = readback.filter((result, idx) => (rows[idx].control === 'n' && !result.found) || (rows[idx].control === 'd' && result.found));
    if (!failures.length || Date.now() >= deadline) return readback;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return readback;
}

async function loginAndUpload(csvPath, csvBuffer, rows, finalSubmit, expectedBefore, walPath, operationId) {
  const required = ['RMS_LOGIN_ID', 'RMS_LOGIN_PASS', 'RAKUTEN_EMAIL', 'RAKUTEN_EMAIL_PASS'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`RMS credentials missing on server: ${missing.join(', ')}`);

  const { chromium, executablePath } = attestedPlaywright();
  const profileDir = '/Users/nob/.hermes/rpp-rms-adapter-profile';
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(profileDir, 0o700);
  const profileLock = acquireProfileLock(profileDir);
  let context = null;
  try {
    context = await chromium.launchPersistentContext(profileDir, { executablePath, headless: true, acceptDownloads: true, locale: 'ja-JP', args: ['--no-sandbox'] });
    const page = context.pages()[0] || await context.newPage();
    let allowUploadDialog = false;
    let unexpectedDialog = null;
    page.on('dialog', async (dialog) => {
      const message = dialog.message().trim();
      if (allowUploadDialog && /除外.*(アップロード|登録).*(よろしいですか|しますか)[？?]?$/.test(message)) {
        await dialog.accept().catch(() => undefined);
      } else {
        unexpectedDialog = message;
        await dialog.dismiss().catch(() => undefined);
      }
    });

    if (process.env.RMS_LOGIN_URL && process.env.RMS_LOGIN_URL !== 'https://glogin.rms.rakuten.co.jp/?sp_id=1') {
      throw new Error('RMS_LOGIN_URL override is forbidden');
    }
    await page.goto('https://glogin.rms.rakuten.co.jp/?sp_id=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    if (await page.locator('input[name="login_id"]').count()) {
      requirePageOrigin(page, ['https://glogin.rms.rakuten.co.jp'], 'RMS credential form');
      await fillCredentialAtOrigin(page.locator('input[name="login_id"]'), 'https://glogin.rms.rakuten.co.jp', process.env.RMS_LOGIN_ID || '', 'RMS login ID');
      await fillCredentialAtOrigin(page.locator('input[name="passwd"]'), 'https://glogin.rms.rakuten.co.jp', process.env.RMS_LOGIN_PASS || '', 'RMS password');
      const btn = page.locator('button:has-text("楽天会員ログイン"), button:has-text("楽天会員ログインへ"), input[value*="楽天会員ログイン"]');
      if (await btn.count()) await btn.first().click();
      await page.waitForTimeout(3000);
    }
    if (await page.locator('#user_id').count()) {
      requirePageOrigin(page, ['https://login.account.rakuten.com'], 'Rakuten account identifier form');
      await fillCredentialAtOrigin(page.locator('#user_id'), 'https://login.account.rakuten.com', process.env.RAKUTEN_EMAIL || '', 'Rakuten account ID');
      await page.locator('#cta001').click();
      await page.waitForTimeout(4000);
    }
    if (await page.locator('#password_current').count()) {
      requirePageOrigin(page, ['https://login.account.rakuten.com'], 'Rakuten account password form');
      await fillCredentialAtOrigin(page.locator('#password_current'), 'https://login.account.rakuten.com', process.env.RAKUTEN_EMAIL_PASS || '', 'Rakuten account password');
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
    requirePageOrigin(page, ['https://ad.rms.rakuten.co.jp'], 'RMS exclusion page');
    const body = await page.evaluate(() => document.body.innerText.slice(0, 2000));
    if (/captcha|画像認証|本人確認|追加認証/i.test(body)) {
      const error = new Error(`RMS CAPTCHA or identity challenge detected; url=${page.url()}`);
      error.stage = 'login';
      throw error;
    }
    if (body.includes('システムエラー') || (body.includes('ログイン') && !body.includes('除外'))) {
      const error = new Error(`RMS login not completed; exclusion upload aborted; url=${page.url()}; title=${await page.title()}; body=${body.replace(/[\r\n]+/g, ' ').slice(0, 600)}`);
      error.stage = 'login';
      throw error;
    }

    const beforeReadback = [];
    for (const row of rows) beforeReadback.push(await searchExclusionStatus(page, row.itemCode));
    const expectedFound = expectedBefore === 'excluded';
    const beforeFailures = beforeReadback.filter((row) => row.found !== expectedFound);
    if (beforeFailures.length) {
      throw new Error(`RMS precondition changed; upload aborted: ${beforeFailures.map((row) => `${row.itemCode} found=${row.found}`).join(' / ')}`);
    }

    const bulkButton = page.locator('#btnBulkUploadExcludeItemOpenModal');
    if (await bulkButton.count() !== 1 || !await bulkButton.isVisible({ timeout: 2000 }).catch(() => false)
        || !await bulkButton.isEnabled({ timeout: 2000 }).catch(() => false)) {
      throw new Error('exact RMS exclusion bulk-upload opener is missing or ambiguous');
    }
    await bulkButton.click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    const primaryUpload = page.locator('#btnUploadFile');
    if (await primaryUpload.count() !== 1) throw new Error('exact RMS exclusion upload button is missing or ambiguous');
    const uploadModal = primaryUpload.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " modal ")][1]');
    if (await uploadModal.count() !== 1 || !await uploadModal.isVisible({ timeout: 2000 }).catch(() => false)) {
      throw new Error('expected RMS exclusion upload modal is missing or ambiguous');
    }
    const fileInput = uploadModal.locator('input[type="file"]');
    if ((await fileInput.count()) !== 1) throw new Error('RMS exclusion upload file input is missing or ambiguous');
    await fileInput.setInputFiles({ name: path.basename(csvPath), mimeType: 'text/csv', buffer: csvBuffer });
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
    const primaryUploadCount = await primaryUpload.count();
    const finalUploadButtonPresent = primaryUploadCount === 1
      && await primaryUpload.isVisible({ timeout: 2000 }).catch(() => false)
      && await primaryUpload.isEnabled({ timeout: 2000 }).catch(() => false);
    if (!finalUploadButtonPresent) throw new Error('exact RMS final upload button not found');
    if (!finalSubmit) return { fileSelected: true, finalSubmitSkipped: true, finalUploadButtonPresent, beforeReadback, ...info };

    if (unexpectedDialog !== null) throw new Error(`unexpected RMS dialog blocked: ${unexpectedDialog}`);
    requireRuntimeActivation(walPath, operationId);
    updateWalPhase(walPath, operationId, 'PREPARED', 'SUBMITTING', csvPath, csvBuffer, rows);
    requireRuntimeActivation(walPath, operationId);
    if (unexpectedDialog !== null) throw new Error(`unexpected RMS dialog blocked: ${unexpectedDialog}`);
    allowUploadDialog = true;
    await primaryUpload.click({ timeout: 10000 });
    allowUploadDialog = false;
    if (unexpectedDialog !== null) throw new Error(`unexpected RMS dialog blocked: ${unexpectedDialog}`);
    updateWalPhase(walPath, operationId, 'SUBMITTING', 'SUBMITTED', csvPath, csvBuffer, rows);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(5000);
    const pageTextSample = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    const failureText = pageTextSample.match(/[^\n]*(失敗|エラー|不正|登録できません|アップロードできません)[^\n]*/g)?.slice(0, 8) || [];
    const readback = await pollExactReadback(page, rows);
    const readbackFailures = readback.filter((row, idx) => (rows[idx].control === 'n' && !row.found) || (rows[idx].control === 'd' && row.found));
    if (failureText.length || readbackFailures.length) {
      throw new Error(`RMS upload verification failed: ${[...failureText, ...readbackFailures.map((row) => `${row.itemCode} readback=${row.found}`)].join(' / ')}`);
    }
    updateWalPhase(walPath, operationId, 'SUBMITTED', 'VERIFIED', csvPath, csvBuffer, rows);
    return { fileSelected: true, finalSubmitClicked: true, pageTextSample, beforeReadback, readback, ...info };
  } finally {
    if (context) await context.close();
    releaseProfileLock(profileLock);
  }
}

async function main() {
  const csvArg = argValue('--csv');
  if (!csvArg) throw new Error('--csv is required');
  const csvPath = path.resolve(csvArg);
  const csvBuffer = fs.readFileSync(csvPath);
  const rows = parseCsv(csvPath);
  const base = { ok: true, productionChange: false, uploadCsv: csvPath, rowCount: rows.length, rows };
  if (!rows.length) { emit({ ...base, skipped: true, reason: 'rows are 0' }); return; }
  if (!hasArg('--execute')) { emit({ ...base, dryRun: true, reason: 'missing --execute' }); return; }
  if (process.env.RPP_ENABLE_RMS_EXCLUSION_UPLOAD !== '1') throw new Error('RPP_ENABLE_RMS_EXCLUSION_UPLOAD=1 is required');
  const finalSubmit = hasArg('--final-submit');
  if (finalSubmit && argValue('--confirm') !== 'RMS_EXCLUSION_UPLOAD') throw new Error('--confirm=RMS_EXCLUSION_UPLOAD is required for final submit');
  const expectedBefore = argValue('--expected-before');
  if (finalSubmit && !['active', 'excluded'].includes(expectedBefore)) throw new Error('--expected-before=active|excluded is required for final submit');
  const walPath = argValue('--wal-stage-file');
  const operationId = argValue('--operation-id');
  if (finalSubmit && (!walPath || !operationId)) throw new Error('--wal-stage-file and --operation-id are required for final submit');
  if (finalSubmit) {
    const bound = validateWalBinding(path.resolve(walPath), operationId, csvPath, csvBuffer, rows);
    const startGate = argValue('--start-gate');
    const capability = process.env.RPP_ADAPTER_CAPABILITY || '';
    const runtimeCommit = process.env.RPP_RUNTIME_COMMIT || '';
    if (!startGate || capability.length < 32) throw new Error('scheduler adapter capability is required');
    if (path.resolve(String(bound.adapterStartGate || '')) !== path.resolve(startGate)
        || fs.readFileSync(startGate, 'utf8') !== `${operationId}:${capability}`
        || bound.adapterPgid !== process.pid) throw new Error('scheduler adapter capability/process binding mismatch');
    if (!runtimeCommit || bound.runtimeCommit !== runtimeCommit) throw new Error('runtime commit binding mismatch');
    const activationPath = process.env.RPP_ACTIVATION_RECEIPT
      || '/Users/nob/Projects/rpp-8am-notify/rpp_apply_logs/rpp_product_delivery_dispatcher_activation.json';
    const activation = JSON.parse(fs.readFileSync(activationPath, 'utf8'));
    if (activation.activated !== true || activation.commit !== runtimeCommit) throw new Error('runtime activation is not valid');
  }
  const applied = await loginAndUpload(csvPath, csvBuffer, rows, finalSubmit, expectedBefore, walPath, operationId);
  emit({ ...base, productionChange: finalSubmit, applied });
}

export function classifyAdapterError(error) {
  const message = String(error?.message || error || '');
  const normalized = message.toLowerCase();
  if (/captcha|challenge|mfa|本人確認|画像認証/.test(normalized)) return 'RMS_CHALLENGE';
  if (/login not completed|credentials missing|401|403|ログイン|認証/.test(normalized)) return 'RMS_AUTH_REQUIRED';
  if (/input not found|button not found|column not found|header invalid|selector/.test(normalized)) return 'RMS_DOM_DRIFT';
  if (/precondition changed/.test(normalized)) return 'RMS_PRECONDITION_CHANGED';
  if (/readback|verified wal stage/.test(normalized)) return 'RMS_READBACK_UNCERTAIN';
  if (/timeout|timed out|econn|enotfound|network|navigation/.test(normalized)) return 'RMS_NETWORK';
  return 'RMS_ADAPTER_ERROR';
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, errorCode: classifyAdapterError(e), stage: e?.stage || 'adapter', message: String(e?.message || e).slice(-1500) }));
    process.exit(1);
  });
}
