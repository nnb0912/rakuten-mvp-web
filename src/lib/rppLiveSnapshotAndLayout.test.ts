import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeRppDashboardSnapshot } from "./rppDashboardSnapshots.ts";

test("dashboard snapshot keeps live configured/exclusion/owner data", () => {
  const snapshot = normalizeRppDashboardSnapshot({
    syncedAt: "2026-09-04T07:32:35Z",
    recommendations: { summary: {}, recommendations: [] },
    latestFiles: [],
    rppData: {
      configuredTargets: [{ id: "r0579__%E5%95%86%E5%93%81CPC", itemCode: "R0579", itemName: "商品", keyword: "商品CPC", itemCpc: 52, keywordCpc: null, source: "商品CPC", owner: "森下" }],
      exclusionProducts: [{ itemCode: "R0579", itemName: "商品", itemCpc: 52, excluded: true, owner: "森下" }],
      owners: ["森下", "遠藤/鎌塚"],
    },
  });
  assert.equal(snapshot.schemaVersion, 3);
  assert.equal(snapshot.rppData?.configuredTargets[0].itemCode, "r0579");
  assert.equal(snapshot.rppData?.exclusionProducts[0].excluded, true);
  assert.deepEqual(snapshot.rppData?.owners, ["森下", "遠藤/鎌塚"]);
});

test("products view receives the full owner directory and contains wide controls", () => {
  const component = readFileSync("src/app/rpp/RppTargetSettings.tsx", "utf8");
  const page = readFileSync("src/app/rpp/page.tsx", "utf8");
  const css = readFileSync("src/app/globals.css", "utf8");
  assert.match(component, /ownerNames: string\[\]/);
  assert.match(component, /for \(const owner of ownerNames\)/);
  assert.match(page, /ownerNames=\{targetData\.ownerNames\}/);
  assert.match(css, /\.owner-filter-strip > \.owner-tabs:first-child\s*\{[^}]*min-width:\s*0[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.adant-list-toolbar\s*\{[^}]*min-width:\s*0[^}]*overflow-x:\s*auto/);
});
