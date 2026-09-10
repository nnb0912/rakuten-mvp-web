import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acquireProfileLock,
  pollExactReadback,
  releaseProfileLock,
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
    assert.match(source, /updateWalPhase\(walPath, operationId, 'VERIFIED'\)/);
  } finally {
    if (original === undefined) delete process.env.RPP_RMS_READBACK_TIMEOUT_MS;
    else process.env.RPP_RMS_READBACK_TIMEOUT_MS = original;
  }
});
