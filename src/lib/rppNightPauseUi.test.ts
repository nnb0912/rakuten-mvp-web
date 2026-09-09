import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("../app/rpp/RppTargetSettings.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/rpp/page.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/rpp/night-pause/route.ts", import.meta.url), "utf8");
const help = readFileSync(new URL("../app/rpp/RppInfoTip.tsx", import.meta.url), "utf8");

test("RPPページは保存済みの夜間停止商品を商品一覧へ渡す", () => {
  assert.match(page, /readRppNightPauseProducts\(\)/);
  assert.match(page, /initialNightPauseItemCodes=\{nightPauseData\.itemCodes\}/);
});

test("商品CPC行だけに夜間停止コントロールを表示する", () => {
  assert.match(component, /productExclusionOperable \? <div className="night-pause-control"/);
  assert.match(component, /夜間停止 \$\{nightPauseEnabled \? "ON" : "OFF"\}/);
  assert.match(component, /01:30 OFF \/ 06:00 ON/);
  assert.doesNotMatch(component, /keyword-exclusion-na[^\n]*夜間停止/);
});

test("クリック時は商品単位APIへ保存し、返却された選択商品で表示を更新する", () => {
  assert.match(component, /fetch\("\/api\/rpp\/night-pause"/);
  assert.match(component, /JSON\.stringify\(\{ itemCode, enabled \}\)/);
  assert.match(component, /setNightPauseItemCodes\(new Set/);
});

test("夜間停止APIはviewer/operator権限とRPP商品存在確認を行う", () => {
  assert.match(route, /requireRppRole\("viewer"\)/);
  assert.match(route, /requireRppRole\("operator"\)/);
  assert.match(route, /typeof body\.enabled !== "boolean"/);
  assert.match(route, /readRppExclusionProducts\(\)/);
  assert.match(route, /RPP商品が見つかりません/);
});

test("夜間停止の説明は商品単位と時刻を明記する", () => {
  assert.match(help, /"夜間停止"/);
  assert.match(help, /01:30.*OFF.*06:00.*ON/);
  assert.match(help, /キーワードCPC単位では設定できません/);
});
