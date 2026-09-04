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

test("target export remains behind the existing bearer authorization", () => {
  const getBody = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  assert.match(getBody, /if \(!authorized\(request\)\)/);
});
