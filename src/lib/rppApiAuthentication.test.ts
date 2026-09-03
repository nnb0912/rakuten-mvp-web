import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const proxySource = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");

const humanOperatedRppRoutes = [
  "targets",
  "meta",
  "recommendations",
  "budget-settings",
  "strategy-settings",
  "experiments",
  "auto-adjustment-settings",
  "regenerate-recommendations",
  "export-approved",
  "export-remove-setting-candidates",
  "validate-remove-setting-candidates",
  "apply-approved",
  "apply-exclusion",
  "anomaly-notify",
  "comparisons",
];

test("human-operated RPP APIs are protected by the auth proxy", () => {
  for (const route of humanOperatedRppRoutes) {
    assert.doesNotMatch(
      proxySource,
      new RegExp(`api/rpp/${route.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?:\\||/)`),
      `api/rpp/${route} must not be excluded from the auth proxy`,
    );
  }
  assert.doesNotMatch(proxySource, /\|rpp\|/, "/rpp must not be excluded from the auth proxy");
});

test("machine RPP APIs keep their route-level bearer-token access", () => {
  assert.match(proxySource, /api\/rpp\/sync-snapshot/);
  assert.match(proxySource, /api\/rpp\/exclusion-jobs/);
});
