import assert from "node:assert/strict";
import test from "node:test";
import { parseRppTargetDraft, rppTargetDraftKey } from "./rppTargetDraft.ts";

test("下書きキーは商品とRPP設定KW単位で正規化する", () => {
  assert.equal(rppTargetDraftKey(" R0445 ", " 商品CPC "), "rpp-target-draft:v1:r0445:商品CPC");
});

test("対象が一致する下書きだけ再開する", () => {
  const draft = { itemCode: "r0445", keyword: "商品CPC", owner: "森下" };
  assert.deepEqual(parseRppTargetDraft(JSON.stringify(draft), "R0445", "商品CPC"), draft);
  assert.equal(parseRppTargetDraft(JSON.stringify(draft), "r0446", "商品CPC"), null);
  assert.equal(parseRppTargetDraft("broken", "r0445", "商品CPC"), null);
});
