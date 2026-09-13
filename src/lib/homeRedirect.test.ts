import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const home = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

test("トップ画面は認証後にRPPダッシュボードへ遷移する", () => {
  assert.match(home, /redirect\(["']\/rpp\?view=dashboard["']\)/);
  assert.doesNotMatch(home, /monthly_product_profit/);
});
