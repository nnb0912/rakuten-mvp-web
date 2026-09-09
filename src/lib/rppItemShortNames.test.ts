import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RPP_ITEM_SHORT_NAMES, shortRppItemName } from "./rppItemShortNames.ts";

test("登録済み商品は商品番号から短縮名を返す", () => {
  assert.equal(shortRppItemName(" C017 ", "長い商品名"), "自転車カバー");
  assert.equal(shortRppItemName("r0406", "長い商品名"), "ゴミステーション");
  assert.equal(shortRppItemName("r0445", "長い商品名"), "掛け時計");
  assert.equal(Object.keys(RPP_ITEM_SHORT_NAMES).length, 711);
});

test("未登録商品は24文字で省略し、短い名前はそのまま返す", () => {
  assert.equal(shortRppItemName("unknown", "短い商品名"), "短い商品名");
  const compact = shortRppItemName("unknown", "1234567890123456789012345 長い商品名");
  assert.equal(Array.from(compact).length, 25);
  assert.equal(compact.endsWith("…"), true);
});

test("RPPの主要一覧は短縮名を使い、完全名をtitleに残す", () => {
  const targets = readFileSync(new URL("../app/rpp/RppTargetSettings.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/rpp/page.tsx", import.meta.url), "utf8");
  assert.ok((targets.match(/shortRppItemName\(/g) ?? []).length >= 3);
  assert.ok((page.match(/shortRppItemName\(/g) ?? []).length >= 3);
  assert.match(targets, /title=\{cfg\.itemName\}/);
  assert.match(targets, /title=\{row\.itemName\}/);
});
