import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const route = readFileSync(join(process.cwd(), "src", "app", "api", "rpp", "sync-snapshot", "route.ts"), "utf8");

test("machine snapshot endpoint can return current RPP targets", () => {
  assert.match(route, /readRppAlertTargets/);
  assert.match(route, /searchParams\.get\("resource"\) === "targets"/);
  assert.match(route, /targets:\s*data\.targets/);
});

test("machine snapshot endpoint can return product night-pause item codes", () => {
  assert.match(route, /readRppNightPauseProducts/);
  assert.match(route, /searchParams\.get\("resource"\) === "night-pause"/);
  assert.match(route, /itemCodes:\s*data\.itemCodes/);
});

test("machine snapshot endpoint can read back exact daily performance rows", () => {
  assert.match(route, /searchParams\.get\("resource"\) === "performance-daily"/);
  assert.match(route, /readRppPerformanceDaily\(date\)/);
});

test("machine exports remain behind the existing bearer authorization", () => {
  const getBody = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  assert.match(getBody, /if \(!authorized\(request\)\)/);
  assert.ok(getBody.indexOf("if (!authorized(request))") < getBody.indexOf('resource") === "night-pause"'));
});

test("machine endpoint exposes read-only snapshot v5 deployment contract", () => {
  assert.match(route, /searchParams\.get\("resource"\) === "contract"/);
  assert.match(route, /snapshotSchemaMax: 5/);
  assert.match(route, /canonicalSnapshotReadback: true/);
});
