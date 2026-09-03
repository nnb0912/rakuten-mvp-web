import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const proxySource = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");

const routePolicies: Record<string, string[]> = {
  "anomaly-notify": ["operator"],
  "apply-approved": ["admin"],
  "apply-exclusion": ["admin"],
  "auto-adjustment-settings": ["viewer", "operator"],
  "budget-settings": ["viewer", "operator"],
  "comparisons": ["viewer"],
  "comparisons/export": ["viewer"],
  "experiments": ["viewer", "operator", "operator"],
  "export-approved": ["operator"],
  "export-remove-setting-candidates": ["viewer", "operator", "operator"],
  "meta": ["viewer"],
  "recommendations": ["viewer", "operator"],
  "regenerate-recommendations": ["operator"],
  "strategy-settings": ["viewer", "operator"],
  "targets": ["viewer", "operator", "operator"],
  "validate-remove-setting-candidates": ["operator"],
};

const machineRoutes = ["sync-snapshot", "exclusion-jobs"];

test("human-operated RPP APIs are protected by the auth proxy", () => {
  for (const route of Object.keys(routePolicies)) {
    assert.doesNotMatch(proxySource, new RegExp(`api/rpp/${route}(?:\\||/)`), `api/rpp/${route} must not be excluded from the auth proxy`);
  }
  assert.doesNotMatch(proxySource, /\|rpp\|/, "/rpp must not be excluded from the auth proxy");
});

test("every human RPP route method has an explicit route-level role guard", () => {
  for (const [route, expectedRoles] of Object.entries(routePolicies)) {
    const source = readFileSync(new URL(`../app/api/rpp/${route}/route.ts`, import.meta.url), "utf8");
    const methods = source.match(/export async function (GET|POST|PATCH|DELETE)/g) ?? [];
    const actualRoles = [...source.matchAll(/requireRppRole\("(viewer|operator|admin)"\)/g)].map((match) => match[1]);
    assert.equal(actualRoles.length, methods.length, `${route} must guard every exported HTTP method`);
    assert.deepEqual(actualRoles, expectedRoles, `${route} role policy changed unexpectedly`);
  }
});

test("machine RPP APIs keep their route-level bearer-token access", () => {
  for (const route of machineRoutes) {
    assert.match(proxySource, new RegExp(`api/rpp/${route}`));
    const source = readFileSync(new URL(`../app/api/rpp/${route}/route.ts`, import.meta.url), "utf8");
    assert.match(source, /authorization/i);
    assert.match(source, /401/);
  }
});

test("real-send anomaly notification requires admin after operator access", () => {
  const source = readFileSync(new URL("../app/api/rpp/anomaly-notify/route.ts", import.meta.url), "utf8");
  assert.match(source, /body\.send === true && access\.role !== "admin"/);
  assert.match(source, /requiredRole: "admin"/);
});
