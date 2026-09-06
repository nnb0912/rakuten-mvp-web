import assert from "node:assert/strict";
import test from "node:test";
import { assertRppExclusionQueueAvailable, parseRppExclusionChanges, requireSingleRppExclusionChange } from "./rppExclusionBatch.ts";

test("RMS除外反映は部分成功防止のため1ジョブ1商品に限定する", () => {
  const one = [{ itemCode: "r0001", currentExcluded: true }];
  assert.equal(requireSingleRppExclusionChange(one).itemCode, "r0001");
  assert.throws(() => requireSingleRppExclusionChange([]), /1ジョブ1商品/);
  assert.throws(() => requireSingleRppExclusionChange([
    { itemCode: "r0001", currentExcluded: true },
    { itemCode: "r0002", currentExcluded: false },
  ]), /1ジョブ1商品/);
});

test("除外変更はboolean以外を拒否して解除安全チェックのすり抜けを防ぐ", () => {
  assert.deepEqual(parseRppExclusionChanges([
    { itemCode: " R0001 ", currentExcluded: false, originalExcluded: true },
  ]), [{ itemCode: "R0001", currentExcluded: false, originalExcluded: true }]);
  assert.throws(() => parseRppExclusionChanges([
    { itemCode: "r0001", currentExcluded: 0, originalExcluded: true },
  ]), /currentExcludedはboolean/);
  assert.throws(() => parseRppExclusionChanges([
    { itemCode: "r0001", currentExcluded: false, originalExcluded: 1 },
  ]), /originalExcludedはboolean/);
});

test("RMSジョブは同一商品重複と別担当者の並行操作を拒否する", () => {
  const own = [{ changes: [{ itemCode: "r0001" }], createdByEmail: "a@example.com", createdByName: "Aさん" }];
  assert.doesNotThrow(() => assertRppExclusionQueueAvailable(own, [{ itemCode: "r0002" }], "a@example.com"));
  assert.throws(() => assertRppExclusionQueueAvailable(own, [{ itemCode: "R0001" }], "a@example.com"), /すでに登録/);
  assert.throws(() => assertRppExclusionQueueAvailable(own, [{ itemCode: "r0002" }], "b@example.com"), /AさんがRMS反映処理中/);
});
