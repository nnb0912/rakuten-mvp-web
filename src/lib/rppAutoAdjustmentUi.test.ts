import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app/rpp/RppAutoAdjustmentSettingsPanel.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../app/rpp/page.tsx", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../app/api/rpp/auto-adjustment-settings/route.ts", import.meta.url), "utf8");

test("全体設定は共通安全項目だけを表示し個別数値と重複させない", () => {
  assert.doesNotMatch(source, /<RppInfoTip label="最低CPC"/);
  assert.doesNotMatch(source, /<RppInfoTip label="商品CPC上限"/);
  assert.doesNotMatch(source, /<RppInfoTip label="KW CPC上限"/);
  assert.doesNotMatch(source, /<RppInfoTip label="ROAS最低"/);
  assert.match(source, /<RppInfoTip label="1回最大上げ"/);
  assert.match(source, /<RppInfoTip label="1回最大下げ"/);
  assert.match(source, /変更不可リストは除外/);
  assert.match(source, /RMS除外中商品は除外/);
});

test("非表示値はclient payloadに含めずserverの最新値を保持する", () => {
  assert.doesNotMatch(source, /floorCpc: settings\.floorCpc/);
  assert.doesNotMatch(source, /itemCpcMax: settings\.itemCpcMax/);
  assert.doesNotMatch(source, /keywordCpcMax: settings\.keywordCpcMax/);
  assert.doesNotMatch(source, /roasFloor: settings\.roasFloor/);
  assert.match(source, /body: JSON\.stringify\(form\)/);
  assert.match(routeSource, /floorCpc: current\.settings\.floorCpc/);
  assert.match(routeSource, /roasFloor: current\.settings\.roasFloor/);
});

test("画面名は対象を誤解させない自動調整設定で統一する", () => {
  assert.match(pageSource, /optimization: \{ label: "自動調整設定"/);
  assert.doesNotMatch(pageSource, /label: "CPC最適化"/);
  assert.doesNotMatch(pageSource, /label: "全商品/);
});