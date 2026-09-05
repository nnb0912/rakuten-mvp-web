import assert from "node:assert/strict";
import test from "node:test";
import {
  ROUTINE_OPTIMIZATION_MODES,
  buildRppOptimizationPreview,
  calculateRoasCpc,
  normalizeRppOptimizationMode,

  validateRppModeCpcBounds,
} from "./rppOptimization.ts";

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

test("バランスモードはROAS未達時にROAS・順位候補の低い方を選ぶ", () => {
  const preview = buildRppOptimizationPreview({
    mode: "BALANCED",
    cpcKind: "ITEM",
    currentCpc: 100,
    actualRoas: 400,
    targetRoas: 500,
    spend: null,
    sales: null,
    positionSuggestedCpc: 60,
  });
  assert.equal(preview.proposedCpc, 60);
});

test("バランスモードはROAS達成時の順位引き上げをROAS候補で抑える", () => {
  const preview = buildRppOptimizationPreview({
    mode: "BALANCED",
    cpcKind: "KEYWORD",
    currentCpc: 100,
    actualRoas: 600,
    targetRoas: 500,
    spend: null,
    sales: null,
    positionSuggestedCpc: 140,
  });
  assert.equal(preview.proposedCpc, 110);
});

test("バランスモードは順位が維持・引き下げを示す場合に順位候補へ従う", () => {
  const held = buildRppOptimizationPreview({ mode: "BALANCED", cpcKind: "ITEM", currentCpc: 100, actualRoas: 700, targetRoas: 500, spend: null, sales: null, positionSuggestedCpc: 100 });
  const lowered = buildRppOptimizationPreview({ mode: "BALANCED", cpcKind: "ITEM", currentCpc: 100, actualRoas: 700, targetRoas: 500, spend: null, sales: null, positionSuggestedCpc: 70 });
  assert.equal(held.proposedCpc, 100);
  assert.equal(lowered.proposedCpc, 70);
});

test("バランスモードはROAS・順位候補の両方を必須にし既存の安全幅と上限を適用する", () => {
  const missingRoas = buildRppOptimizationPreview({ mode: "BALANCED", cpcKind: "ITEM", currentCpc: 100, actualRoas: null, targetRoas: 500, spend: null, sales: null, positionSuggestedCpc: 80 });
  const missingPosition = buildRppOptimizationPreview({ mode: "BALANCED", cpcKind: "ITEM", currentCpc: 100, actualRoas: 600, targetRoas: 500, spend: null, sales: null, positionSuggestedCpc: null });
  const capped = buildRppOptimizationPreview({ mode: "BALANCED", cpcKind: "ITEM", currentCpc: 100, actualRoas: 1_000, targetRoas: 500, spend: null, sales: null, positionSuggestedCpc: 200, maxCpc: 115 });
  assert.equal(missingRoas.blockedReason, "ROAS実績・目標または検索順位ベース提案不足");
  assert.equal(missingPosition.blockedReason, "ROAS実績・目標または検索順位ベース提案不足");
  assert.equal(capped.proposedCpc, 115);
});

test("CPC固定モードはRMS直接登録と同様に指定額を維持し、楽天下限だけを守る", () => {
  const down = buildRppOptimizationPreview({ mode: "FIXED", cpcKind: "ITEM", currentCpc: 100, actualRoas: null, targetRoas: 500, spend: null, sales: null, fixedCpc: 20 });
  const up = buildRppOptimizationPreview({ mode: "FIXED", cpcKind: "ITEM", currentCpc: 100, actualRoas: null, targetRoas: 500, spend: null, sales: null, fixedCpc: 200 });
  const keywordFloor = buildRppOptimizationPreview({ mode: "FIXED", cpcKind: "KEYWORD", currentCpc: 100, actualRoas: null, targetRoas: 500, spend: null, sales: null, fixedCpc: 10 });
  assert.equal(down.proposedCpc, 20);
  assert.equal(up.proposedCpc, 200);
  assert.equal(keywordFloor.proposedCpc, 40);
});

test("変更不可とデータ不足は提案を生成しない", () => {
  assert.equal(buildRppOptimizationPreview({ mode: "ROAS", cpcKind: "ITEM", currentCpc: 40, actualRoas: 900, targetRoas: 500, spend: 100, sales: 900, changeLocked: true }).blockedReason, "変更不可リスト");
  assert.equal(buildRppOptimizationPreview({ mode: "ROAS", cpcKind: "ITEM", currentCpc: 40, actualRoas: null, targetRoas: 500, spend: 100, sales: 0 }).blockedReason, "ROAS実績または目標不足");
});

test("CPC固定モードは旧実験終了日が残っていても通常運用として動作する", () => {
  const preview = buildRppOptimizationPreview({ mode: "FIXED", cpcKind: "ITEM", currentCpc: 40, actualRoas: 900, targetRoas: 500, spend: 100, sales: 900, fixedCpc: 40, experimentEndDate: "2026-08-30", today: "2026-08-31" });
  assert.equal(preview.blockedReason, null);
  assert.equal(preview.proposedCpc, 40);
});

test("4つの通常運用モードは終了日なし・実験履歴なしで動作する", () => {
  assert.deepEqual(ROUTINE_OPTIMIZATION_MODES.map(({ value, label }) => ({ value, label })), [
    { value: "ROAS", label: "ROASモード" },
    { value: "POSITION", label: "検索順位モード" },
    { value: "BALANCED", label: "バランスモード" },
    { value: "FIXED", label: "CPC固定モード" },
  ]);

});

test("最適化モード正規化はBALANCEDを受け入れ、既存FIXEDを読み続ける", () => {
  assert.equal(normalizeRppOptimizationMode("BALANCED"), "BALANCED");
  assert.equal(normalizeRppOptimizationMode("FIXED"), "FIXED");
  assert.equal(normalizeRppOptimizationMode("unknown"), "ROAS");
  assert.equal(normalizeRppOptimizationMode(null), "ROAS");
});

test("3つの通常運用モードはそれぞれのCPC下限・上限を提案後に適用する", () => {
  const roas = buildRppOptimizationPreview({ mode: "ROAS", cpcKind: "ITEM", currentCpc: 100, actualRoas: 1_000, targetRoas: 500, spend: null, sales: null, roasMinCpc: 90, roasMaxCpc: 105 });
  const position = buildRppOptimizationPreview({ mode: "POSITION", cpcKind: "ITEM", currentCpc: 100, actualRoas: null, targetRoas: 500, spend: null, sales: null, positionSuggestedCpc: 50, positionMinCpc: 80, positionMaxCpc: 110 });
  const balanced = buildRppOptimizationPreview({ mode: "BALANCED", cpcKind: "ITEM", currentCpc: 100, actualRoas: 600, targetRoas: 500, spend: null, sales: null, positionSuggestedCpc: 140, balancedMinCpc: 80, balancedMaxCpc: 105 });
  assert.equal(roas.proposedCpc, 105);
  assert.equal(position.proposedCpc, 80);
  assert.equal(balanced.proposedCpc, 105);
});

test("楽天の絶対CPC下限がモード別上限より優先される", () => {
  const preview = buildRppOptimizationPreview({ mode: "POSITION", cpcKind: "ITEM", currentCpc: 30, actualRoas: null, targetRoas: 500, spend: null, sales: null, positionSuggestedCpc: 1, positionMaxCpc: 10 });
  assert.equal(preview.proposedCpc, 20);
});

test("モード別上限がない既存データはlegacy maxCpcをフォールバック利用する", () => {
  const preview = buildRppOptimizationPreview({ mode: "ROAS", cpcKind: "ITEM", currentCpc: 100, actualRoas: 1_000, targetRoas: 500, spend: null, sales: null, maxCpc: 105 });
  assert.equal(preview.proposedCpc, 105);
});

test("各モードのCPC下限が上限を超える設定を拒否する", () => {
  assert.throws(() => validateRppModeCpcBounds({ roasMinCpc: 101, roasMaxCpc: 100 }), /ROASモードのCPC下限は上限以下/);
  assert.throws(() => validateRppModeCpcBounds({ positionMinCpc: 81, positionMaxCpc: 80 }), /検索順位モードのCPC下限は上限以下/);
  assert.throws(() => validateRppModeCpcBounds({ balancedMinCpc: 71, balancedMaxCpc: 70 }), /バランスモードのCPC下限は上限以下/);
});

test("4保護区分を適用する", () => {
  const base = { mode: "POSITION" as const, cpcKind: "KEYWORD" as const, currentCpc: 100, actualRoas: 900, targetRoas: 500, spend: 100, sales: 900, positionSuggestedCpc: 200 };
  assert.equal(buildRppOptimizationPreview({ ...base, protectionType: "BLOCK" }).blockedReason, "ブロック対象");
  assert.equal(buildRppOptimizationPreview({ ...base, protectionType: "LOCKED" }).blockedReason, "変更不可リスト");
  assert.equal(buildRppOptimizationPreview({ ...base, protectionType: "WHITELIST" }).proposedCpc, 120);
  assert.equal(buildRppOptimizationPreview({ ...base, protectionType: "FOCUS" }).proposedCpc, 150);
});
