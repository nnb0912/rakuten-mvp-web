import assert from "node:assert/strict";
import test from "node:test";
import { formatRppClicks, formatRppYen } from "./rppMetricDisplay.ts";

test("未取得と実績ゼロを区別する", () => {
  assert.equal(formatRppYen(null), "未取得");
  assert.equal(formatRppYen(undefined), "未取得");
  assert.equal(formatRppYen(0), "0円");
  assert.equal(formatRppClicks(null), "未取得");
  assert.equal(formatRppClicks(0), "0 click");
});

test("取得済み実績を日本語表示する", () => {
  assert.equal(formatRppYen(8112), "8,112円");
  assert.equal(formatRppClicks(226), "226 click");
});