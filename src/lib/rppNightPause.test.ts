import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectDir = await mkdtemp(path.join(os.tmpdir(), "rpp-night-pause-"));
process.env.RPP_PROJECT_DIR = projectDir;
const { readRppNightPauseProducts, writeRppNightPauseProduct } = await import("./rppNightPause.ts");

test.after(async () => {
  delete process.env.RPP_PROJECT_DIR;
  await rm(projectDir, { recursive: true, force: true });
});

test("商品別夜間停止をJSONフォールバックへ保存し、ON対象だけ返す", async () => {
  let saved = await writeRppNightPauseProduct(" Item-A ", true);
  assert.deepEqual(saved.itemCodes, ["item-a"]);
  assert.equal(saved.products[0]?.enabled, true);

  saved = await writeRppNightPauseProduct("ITEM-B", true);
  assert.deepEqual(saved.itemCodes, ["item-a", "item-b"]);

  saved = await writeRppNightPauseProduct("item-a", false);
  assert.deepEqual(saved.itemCodes, ["item-b"]);
  assert.equal(saved.products.find((row) => row.itemCode === "item-a")?.enabled, false);

  const readback = await readRppNightPauseProducts();
  assert.deepEqual(readback.itemCodes, ["item-b"]);
  const persisted = JSON.parse(await readFile(path.join(projectDir, "rpp_targets", "rpp_night_pause_products.json"), "utf8"));
  assert.equal(persisted.products.length, 2);
});

test("空の商品管理番号とboolean以外を拒否する", async () => {
  await assert.rejects(() => writeRppNightPauseProduct(" ", true), /商品管理番号は必須/);
  await assert.rejects(() => writeRppNightPauseProduct("item-a", "true" as unknown as boolean), /boolean/);
});
