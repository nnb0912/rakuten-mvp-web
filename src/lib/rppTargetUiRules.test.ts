import assert from "node:assert/strict";
import test from "node:test";
import { canOperateProductExclusion, deliveryLabel } from "./rppTargetUiRules.ts";

test("商品除外操作は商品CPC行だけに表示する", () => {
  assert.equal(canOperateProductExclusion("商品CPC"), true);
  assert.equal(canOperateProductExclusion("キーワードCPC"), false);
});

test("KWCPC行では商品除外状態を操作ではなく状態として示す", () => {
  assert.equal(deliveryLabel("商品CPC", true), "除外ON");
  assert.equal(deliveryLabel("キーワードCPC", true), "商品側除外");
  assert.equal(deliveryLabel("キーワードCPC", false), "配信中");
});
