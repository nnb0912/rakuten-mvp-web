import assert from "node:assert/strict";
import test from "node:test";
import type { RppRecommendation } from "./rppRecommendations.ts";
import { recommendationId } from "./rppRecommendationId.ts";

function recommendation(overrides: Partial<RppRecommendation> = {}): RppRecommendation {
  return {
    date: "2026-09-06T12:00:00Z",
    itemCode: "r0445",
    itemName: "時計",
    keyword: "商品CPC",
    direction: "up",
    action: "RAISE",
    currentCpc: 20,
    meyasuCpc: 40,
    proposedCpc: 24,
    delta: 4,
    source: "商品CPC",
    clicks: 10,
    spend: 100,
    salesAmount: 1000,
    roas: 1000,
    cvr: 5,
    rppPosition: "PC 5位 / SP 5位",
    reasons: [],
    blocks: [],
    uploadReady: false,
    note: "提案のみ",
    ...overrides,
  };
}

test("承認IDは正確な提案CPCと動作へ結び付く", () => {
  const base = recommendation();
  assert.notEqual(recommendationId(base), recommendationId(recommendation({ proposedCpc: 25, delta: 5 })));
  assert.notEqual(recommendationId(base), recommendationId(recommendation({ action: "LOWER", direction: "down", proposedCpc: 18, delta: -2 })));
  assert.notEqual(recommendationId(base), recommendationId(recommendation({ date: "2026-09-07T12:00:00Z" })));
  assert.notEqual(recommendationId(base), recommendationId(recommendation({ reasons: ["別の根拠"] })));
  assert.notEqual(recommendationId(base), recommendationId(recommendation({ blocks: ["鮮度不足"], uploadReady: false })));
});
