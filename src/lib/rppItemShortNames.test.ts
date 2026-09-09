import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  RPP_ITEM_SHORT_NAMES,
  RPP_ITEM_SHORT_NAMES_SOURCE_SHEET_ID,
  shortRppItemName,
} from "./rppItemShortNames.ts";

test("指定SCMシートの商品コードから短縮名を返す", () => {
  assert.equal(RPP_ITEM_SHORT_NAMES_SOURCE_SHEET_ID, "1_8bJ4GAyv25PpASeE6h_Psw3EsRK6OpFfcasmt2REEA");
  assert.equal(shortRppItemName(" C017 ", "長い商品名"), "自転車カバー");
  assert.equal(shortRppItemName("r0406", "長い商品名"), "ゴミステーション");
  assert.equal(shortRppItemName("r0445", "長い商品名"), "壁掛け時計");
  assert.equal(shortRppItemName("r0643-1", "長い商品名"), "スマートタグ");
  assert.equal(Object.keys(RPP_ITEM_SHORT_NAMES).length, 1543);
});

test("現行RPP商品はすべて短縮名登録済みで、未登録は除外中旧商品だけ", () => {
  const snapshot = JSON.parse(readFileSync(new URL("../data/rpp_exclusion_products.json", import.meta.url), "utf8")) as { products: { itemCode: string; excluded: boolean }[] };
  const missing = snapshot.products.filter((row) => !RPP_ITEM_SHORT_NAMES[row.itemCode.toLowerCase()]);
  assert.equal(missing.filter((row) => !row.excluded).length, 0);
  assert.equal(new Set(missing.map((row) => row.itemCode.toLowerCase())).size, 48);
});

test("未登録の旧商品は24文字で省略し、短い名前はそのまま返す", () => {
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
