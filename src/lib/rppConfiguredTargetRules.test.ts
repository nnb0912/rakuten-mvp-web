import assert from "node:assert/strict";
import test from "node:test";
import { resolveKeywordTargetContext } from "./rppConfiguredTargetRules.ts";

test("商品CPC行がなくてもKWCPC単独商品を担当付きで採用する", () => {
  assert.deepEqual(resolveKeywordTargetContext({
    itemCode: "y0662",
    rowItemName: "デスクライト",
    rowItemCpc: null,
    ownerMap: { y0662: "森下" },
    excluded: false,
  }), {
    itemName: "デスクライト",
    itemCpc: null,
    owner: "森下",
  });
});

test("商品除外中の商品はKWCPC行も表示対象外にする", () => {
  assert.equal(resolveKeywordTargetContext({
    itemCode: "y0662-1",
    rowItemName: "デスクライト",
    rowItemCpc: 20,
    ownerMap: {},
    excluded: true,
  }), null);
});
