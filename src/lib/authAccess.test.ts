import assert from "node:assert/strict";
import test from "node:test";
import { decideAuthorization } from "./authAccess.ts";

test("authenticated requests are allowed", () => {
  assert.equal(decideAuthorization("/api/rpp/targets", "operator@example.com"), "allow");
  assert.equal(decideAuthorization("/rpp", "operator@example.com"), "allow");
});

test("unauthenticated API requests receive a JSON 401 decision", () => {
  assert.equal(decideAuthorization("/api/rpp/targets", null), "api-unauthorized");
  assert.equal(decideAuthorization("/api/rpp/apply-exclusion", null), "api-unauthorized");
});

test("unauthenticated pages redirect while login stays public", () => {
  assert.equal(decideAuthorization("/rpp", null), "page-unauthorized");
  assert.equal(decideAuthorization("/login", null), "allow");
});
