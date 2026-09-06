import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const component = readFileSync(join(process.cwd(), "src", "app", "rpp", "RppTargetSettings.tsx"), "utf8");
const infoTip = readFileSync(join(process.cwd(), "src", "app", "rpp", "RppInfoTip.tsx"), "utf8");
const targets = readFileSync(join(process.cwd(), "src", "lib", "rppTargets.ts"), "utf8");

test("商品CPCの基準ワードは複数追加でき、1語以上を必須とする", () => {
  assert.match(component, /label="基準ワード"[^\n]*（複数可・1語以上必須）/);
  assert.match(component, /＋ 基準ワードを追加/);
  assert.match(component, /removeBasisWordSlot/);
  assert.match(component, /required=\{form\.keyword === "商品CPC" && index === 0\}/);
  assert.match(component, /どれか1つでもPC・SPの目標順位を満たせば達成/);
  assert.match(targets, /商品CPCの場合は基準ワードを1つ以上入力してください/);
});

test("基準ワードの意味を画面内で説明する", () => {
  assert.match(infoTip, /"基準ワード"/);
  assert.match(infoTip, /複数追加/);
  assert.match(infoTip, /どれか1つ/);
});
