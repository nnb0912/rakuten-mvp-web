import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../app/rpp/page.tsx", import.meta.url), "utf8");

test("異常チェックはダッシュボードに件数と詳細を表示する", () => {
  assert.match(page, /id="rpp-dashboard-anomalies"/);
  assert.match(page, /<span>異常チェック<\/span><strong>/);
  assert.match(page, /anomalyData\.anomalies\.map/);
  assert.match(page, /CPC・ROAS・広告費・データ鮮度・取得件数/);
  assert.match(page, /最終観測:/);
});

test("異常アラートの独立メニューと専用画面を表示しない", () => {
  assert.doesNotMatch(page, /alerts: \{ label: "異常アラート"/);
  assert.doesNotMatch(page, /view === "alerts"|view=alerts|RppAnomalyAlertPanel/);
});
