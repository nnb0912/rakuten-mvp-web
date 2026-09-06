import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("../app/rpp/RppTargetSettings.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/rpp/collaboration/route.ts", import.meta.url), "utf8");

test("編集開始・heartbeat・解除を利用者操作なしで行う", () => {
  assert.match(component, /action:\s*"acquire"/);
  assert.match(component, /action:\s*"heartbeat"/);
  assert.match(component, /action:\s*"release"/);
  assert.match(component, /60_000/);
  assert.match(route, /requireRppRole\("operator"\)/);
});

test("商品KW下書きをブラウザへ自動保存し保存APIへロックトークンを渡す", () => {
  assert.match(component, /localStorage\.setItem/);
  assert.match(component, /parseRppTargetDraft/);
  assert.match(component, /editLockToken:\s*editSession\.token/);
  assert.match(component, /下書き保存済み/);
});

test("編集中担当者とRMS反映担当者を表示して反映中はボタンを止める", () => {
  assert.match(component, /rpp-collaboration-banner/);
  assert.match(component, /actorName/);
  assert.match(component, /Boolean\(activeOperation\)/);
  assert.match(component, /RMS反映中/);
});
