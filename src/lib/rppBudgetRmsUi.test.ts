import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app/rpp/RppBudgetPanel.tsx", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../app/api/rpp/budget-settings/route.ts", import.meta.url), "utf8");

test("予算管理はRMS有効予算を表示し、当月・翌月予算の入力欄を持たない", () => {
  assert.match(source, /RMS有効予算/);
  assert.match(source, /着地差額/);
  assert.doesNotMatch(source, /label="当月予算"/);
  assert.doesNotMatch(source, /label="翌月予算"/);
  assert.match(source, /rmsBudget\.state === "READY"/);
});

test("配分設定APIはlegacy予算列を入力値で上書きしない", () => {
  assert.match(routeSource, /monthlyBudget: current\.settings\.monthlyBudget/);
  assert.match(routeSource, /nextMonthBudget: current\.settings\.nextMonthBudget/);
});
