import assert from "node:assert/strict";
import test from "node:test";
import { buildRppOptimizationPreview, calculateRoasCpc } from "./rppOptimization.ts";

test("ADant ROAS逆算式の既知6件と一致する", () => {
  assert.equal(calculateRoasCpc(44, 584, 1500, "ITEM"), 22);
  assert.equal(calculateRoasCpc(30, 1139, 1500, "ITEM"), 23);
  assert.equal(calculateRoasCpc(32, 561, 1500, "ITEM"), 20);
  assert.equal(calculateRoasCpc(80, 498, 1500, "KEYWORD"), 40);
  assert.equal(calculateRoasCpc(20, 1740, 1500, "ITEM"), 22);
  assert.equal(calculateRoasCpc(20, 4644, 1500, "ITEM"), 24);
});

test("ROASプレビューは広告費と改善後ROASをCPC比で試算する", () => {
  const preview = buildRppOptimizationPreview({
    mode: "ROAS",
    cpcKind: "ITEM",
    currentCpc: 44,
    actualRoas: 584,
    targetRoas: 1500,
    spend: 100_000,
    sales: 584_000,
  });
  assert.equal(preview.proposedCpc, 22);
  assert.equal(preview.projectedSpend, 50_000);
  assert.equal(preview.savings, 50_000);
  assert.equal(preview.projectedRoas, 1168);
});

test("順位目標モードは既存順位提案を上限CPC以内に制限する", () => {
  const preview = buildRppOptimizationPreview({
    mode: "POSITION",
    cpcKind: "KEYWORD",
    currentCpc: 100,
    actualRoas: 800,
    targetRoas: 500,
    spend: 10_000,
    sales: 80_000,
    positionSuggestedCpc: 140,
    maxCpc: 115,
  });
  assert.equal(preview.proposedCpc, 115);
});

test("固定CPCモードも1回あたりの安全幅を超えない", () => {
  const down = buildRppOptimizationPreview({ mode: "FIXED", cpcKind: "ITEM", currentCpc: 100, actualRoas: null, targetRoas: 500, spend: null, sales: null, fixedCpc: 20 });
  const up = buildRppOptimizationPreview({ mode: "FIXED", cpcKind: "ITEM", currentCpc: 100, actualRoas: null, targetRoas: 500, spend: null, sales: null, fixedCpc: 200 });
  assert.equal(down.proposedCpc, 50);
  assert.equal(up.proposedCpc, 120);
});

test("変更不可とデータ不足は提案を生成しない", () => {
  assert.equal(buildRppOptimizationPreview({ mode: "ROAS", cpcKind: "ITEM", currentCpc: 40, actualRoas: 900, targetRoas: 500, spend: 100, sales: 900, changeLocked: true }).blockedReason, "変更不可リスト");
  assert.equal(buildRppOptimizationPreview({ mode: "ROAS", cpcKind: "ITEM", currentCpc: 40, actualRoas: null, targetRoas: 500, spend: 100, sales: 0 }).blockedReason, "ROAS実績または目標不足");
});

test("実験終了日を過ぎた順位・固定モードは提案を停止する", () => {
  const preview = buildRppOptimizationPreview({ mode: "FIXED", cpcKind: "ITEM", currentCpc: 40, actualRoas: 900, targetRoas: 500, spend: 100, sales: 900, fixedCpc: 40, experimentEndDate: "2026-08-30", today: "2026-08-31" });
  assert.equal(preview.blockedReason, "実験期間終了");
});

test("4保護区分を適用する", () => {
  const base = { mode: "POSITION" as const, cpcKind: "KEYWORD" as const, currentCpc: 100, actualRoas: 900, targetRoas: 500, spend: 100, sales: 900, positionSuggestedCpc: 200 };
  assert.equal(buildRppOptimizationPreview({ ...base, protectionType: "BLOCK" }).blockedReason, "ブロック対象");
  assert.equal(buildRppOptimizationPreview({ ...base, protectionType: "LOCKED" }).blockedReason, "変更不可リスト");
  assert.equal(buildRppOptimizationPreview({ ...base, protectionType: "WHITELIST" }).proposedCpc, 120);
  assert.equal(buildRppOptimizationPreview({ ...base, protectionType: "FOCUS" }).proposedCpc, 150);
});
