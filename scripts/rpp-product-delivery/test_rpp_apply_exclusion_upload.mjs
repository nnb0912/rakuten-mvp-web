import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  acquireProfileLock,
  classifyAdapterError,
  pollExactReadback,
  releaseProfileLock,
  treeSha256,
} from '../rpp_apply_exclusion_upload.mjs';

test('persistent RMS profile has an exclusive adapter lock', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rpp-profile-'));
  const first = acquireProfileLock(profile);
  try {
    assert.throws(() => acquireProfileLock(profile), /locked by pid/);
  } finally {
    releaseProfileLock(first);
  }
  const second = acquireProfileLock(profile);
  releaseProfileLock(second);
  fs.rmSync(profile, { recursive: true, force: true });
});

test('post-submit exact readback polls until the RMS transition appears', async () => {
  let searches = 0;
  const rows = [{ itemCode: 'item-a', control: 'n' }];
  const result = await pollExactReadback({}, rows, {
    timeoutMs: 100,
    intervalMs: 1,
    search: async (_page, itemCode) => ({ itemCode, found: ++searches >= 3 }),
    sleep: async () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  assert.equal(searches, 3);
  assert.equal(result[0].found, true);
});

test('post-submit polling never waits beyond three minutes', async () => {
  const original = process.env.RPP_RMS_READBACK_TIMEOUT_MS;
  process.env.RPP_RMS_READBACK_TIMEOUT_MS = '999999';
  try {
    const source = fs.readFileSync(new URL('../rpp_apply_exclusion_upload.mjs', import.meta.url), 'utf8');
    assert.match(source, /Math\.min\(180000/);
    assert.match(source, /updateWalPhase\(walPath, operationId, 'SUBMITTED', 'VERIFIED'/);
  } finally {
    if (original === undefined) delete process.env.RPP_RMS_READBACK_TIMEOUT_MS;
    else process.env.RPP_RMS_READBACK_TIMEOUT_MS = original;
  }
});

test('adapter failures expose stable circuit-breaker error codes', () => {
  assert.equal(classifyAdapterError(new Error('RMS login not completed')), 'RMS_AUTH_REQUIRED');
  assert.equal(classifyAdapterError(new Error('CAPTCHA challenge')), 'RMS_CHALLENGE');
  assert.equal(classifyAdapterError(new Error('RMS exclusion upload file input not found')), 'RMS_DOM_DRIFT');
  assert.equal(classifyAdapterError(new Error('navigation timeout')), 'RMS_NETWORK');
  assert.equal(classifyAdapterError(new Error('RMS precondition changed')), 'RMS_PRECONDITION_CHANGED');
});

test('final submit is rejected before login when WAL identity is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpp-adapter-wal-'));
  const csv = path.join(root, 'row.csv');
  fs.writeFileSync(csv, 'コントロールカラム,商品管理番号\nn,r0445\n');
  const adapter = new URL('../rpp_apply_exclusion_upload.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [adapter.pathname, `--csv=${csv}`, '--execute', '--final-submit',
    '--confirm=RMS_EXCLUSION_UPLOAD', '--expected-before=active'],
  { encoding: 'utf8', env: { ...process.env, RPP_ENABLE_RMS_EXCLUSION_UPLOAD: '1' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /wal-stage-file and --operation-id are required/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('final submit rejects a CSV that does not match its PREPARED WAL', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpp-adapter-bind-'));
  const csv = path.join(root, 'row.csv');
  const wal = path.join(root, 'wal.json');
  fs.writeFileSync(csv, 'コントロールカラム,商品管理番号\nn,r0445\n');
  fs.writeFileSync(wal, JSON.stringify({ operationId: 'op-1', phase: 'PREPARED', csvPath: csv,
    csvSha256: '0'.repeat(64), csvBytes: 1, csvRows: [{ control: 'n', itemCode: 'r0445' }] }));
  const adapter = new URL('../rpp_apply_exclusion_upload.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [adapter.pathname, `--csv=${csv}`, '--execute', '--final-submit',
    '--confirm=RMS_EXCLUSION_UPLOAD', '--expected-before=active', `--wal-stage-file=${wal}`, '--operation-id=op-1'],
  { encoding: 'utf8', env: { ...process.env, RPP_ENABLE_RMS_EXCLUSION_UPLOAD: '1' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WAL CSV payload binding mismatch/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('destructive exclusion controls have no broad text or first-input fallback', () => {
  const source = fs.readFileSync(new URL('../rpp_apply_exclusion_upload.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /getByText\(text, \{ exact: false \}\)/);
  assert.doesNotMatch(source, /locator\('input\[type="file"\]'\)\.first\(\)/);
  assert.match(source, /#btnBulkUploadExcludeItemOpenModal/);
  assert.match(source, /#btnUploadFile/);
  assert.doesNotMatch(source, /openedBulkUpload/);
});

test('dependency hash rejects a symlink escaping the immutable root', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rpp-tree-'));
  const root = path.join(directory, 'root');
  fs.mkdirSync(root);
  const external = path.join(directory, 'external');
  fs.writeFileSync(external, 'mutable');
  fs.symlinkSync(external, path.join(root, 'escape'));
  assert.throws(() => treeSha256(root), /escapes immutable root/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('valid PREPARED WAL cannot bypass scheduler capability fencing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpp-adapter-direct-'));
  const csv = path.join(root, 'row.csv');
  const wal = path.join(root, 'wal.json');
  const gate = path.join(root, 'gate');
  const bytes = Buffer.from('コントロールカラム,商品管理番号\nn,r0445\n');
  fs.writeFileSync(csv, bytes);
  fs.writeFileSync(gate, 'op-1:not-a-valid-capability');
  fs.writeFileSync(wal, JSON.stringify({ operationId: 'op-1', phase: 'PREPARED', csvPath: csv,
    csvSha256: createHash('sha256').update(bytes).digest('hex'), csvBytes: bytes.length,
    csvRows: [{ control: 'n', itemCode: 'r0445' }], adapterStartGate: gate, adapterPgid: process.pid }));
  const adapter = new URL('../rpp_apply_exclusion_upload.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [adapter.pathname, `--csv=${csv}`, '--execute', '--final-submit',
    '--confirm=RMS_EXCLUSION_UPLOAD', '--expected-before=active', `--wal-stage-file=${wal}`,
    '--operation-id=op-1', `--start-gate=${gate}`],
  { encoding: 'utf8', env: { ...process.env, RPP_ENABLE_RMS_EXCLUSION_UPLOAD: '1' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /scheduler adapter capability is required/);
  fs.rmSync(root, { recursive: true, force: true });
});
