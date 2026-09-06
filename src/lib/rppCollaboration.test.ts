import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireRppEditLock,
  heartbeatRppEditLock,
  listActiveRppEditLocks,
  releaseRppEditLock,
} from "./rppCollaboration.ts";

async function withStore(run: () => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rpp-collab-"));
  const previous = process.env.RPP_COLLAB_DATA_DIR;
  process.env.RPP_COLLAB_DATA_DIR = dir;
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env.RPP_COLLAB_DATA_DIR;
    else process.env.RPP_COLLAB_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("同一商品は他ユーザーを拒否し同一ユーザーは同じロックを再利用する", async () => withStore(async () => {
  const first = await acquireRppEditLock(" R0445 ", { email: "a@example.com", name: "Aさん" }, 60_000);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const same = await acquireRppEditLock("r0445", { email: "a@example.com", name: "Aさん" }, 60_000);
  assert.equal(same.ok, true);
  if (same.ok) assert.equal(same.token, first.token);
  const other = await acquireRppEditLock("r0445", { email: "b@example.com", name: "Bさん" }, 60_000);
  assert.equal(other.ok, false);
  if (!other.ok) assert.equal(other.lock.actorName, "Aさん");
}));

test("期限切れロックは別ユーザーが自動取得できる", async () => withStore(async () => {
  const first = await acquireRppEditLock("r0445", { email: "a@example.com", name: "Aさん" }, -1);
  assert.equal(first.ok, true);
  const second = await acquireRppEditLock("r0445", { email: "b@example.com", name: "Bさん" }, 60_000);
  assert.equal(second.ok, true);
  const active = await listActiveRppEditLocks();
  assert.deepEqual(active.map((row) => row.actorName), ["Bさん"]);
}));

test("heartbeatと解除は所有者・トークンが一致する場合だけ成功する", async () => withStore(async () => {
  const acquired = await acquireRppEditLock("r0445", { email: "a@example.com", name: "Aさん" }, 60_000);
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;
  assert.equal(await heartbeatRppEditLock("r0445", "wrong", "a@example.com", 60_000), null);
  assert.equal(await heartbeatRppEditLock("r0445", acquired.token, "a@example.com", 60_000) != null, true);
  assert.equal(await releaseRppEditLock("r0445", "wrong", "a@example.com"), false);
  assert.equal(await releaseRppEditLock("r0445", acquired.token, "a@example.com"), true);
  assert.equal((await listActiveRppEditLocks()).length, 0);
}));

test("目標保存APIは編集ロックトークンを必須にする", () => {
  const source = readFileSync(new URL("../app/api/rpp/targets/route.ts", import.meta.url), "utf8");
  assert.match(source, /editLockToken/);
  assert.match(source, /heartbeatRppEditLock/);
  assert.match(source, /status:\s*409/);
});
