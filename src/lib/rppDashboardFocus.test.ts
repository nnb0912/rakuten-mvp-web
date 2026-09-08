import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.join(process.cwd(), "src/app/rpp/page.tsx"), "utf8");

test("ダッシュボードは許可商品と前日実績を主表示する", () => {
  assert.match(source, /自動調整を許可した商品/);
  assert.match(source, /allowedItemCodes/);
  assert.match(source, /前日広告費/);
  assert.match(source, /前日売上/);
  assert.match(source, /前日ROAS/);
  assert.match(source, /RMSへの自動反映なし/);
  assert.match(source, /allowedItemCodes\.flatMap/);
  assert.match(source, /recommendation\.keyword/);
  assert.match(source, /商品CPC・KWCPC別/);
  assert.match(source, /許可商品<\/span><strong>\{allowedItemCodes\.length\}/);
  assert.match(source, /excludedAllowedProducts/);
});
