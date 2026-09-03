import assert from "node:assert/strict";
import test from "node:test";
import { decideAuthorization, getRppRoleForEmail, hasRppRole } from "./authAccess.ts";

const env = {
  AUTH_ADMIN_EMAILS: "admin@example.com",
  AUTH_OPERATOR_EMAILS: "operator@example.com",
  AUTH_VIEWER_EMAILS: "viewer@example.com",
  AUTH_ALLOWED_EMAILS: "legacy@example.com",
} as unknown as NodeJS.ProcessEnv;

test("explicit and legacy allowlists map to the intended RPP roles", () => {
  assert.equal(getRppRoleForEmail("ADMIN@example.com", env), "admin");
  assert.equal(getRppRoleForEmail("operator@example.com", env), "operator");
  assert.equal(getRppRoleForEmail("viewer@example.com", env), "viewer");
  assert.equal(getRppRoleForEmail("legacy@example.com", env), "operator");
  assert.equal(getRppRoleForEmail("unknown@example.com", env), null);
});

test("role hierarchy prevents viewers and operators from exceeding their permissions", () => {
  assert.equal(hasRppRole("viewer", "viewer"), true);
  assert.equal(hasRppRole("viewer", "operator"), false);
  assert.equal(hasRppRole("operator", "viewer"), true);
  assert.equal(hasRppRole("operator", "admin"), false);
  assert.equal(hasRppRole("admin", "admin"), true);
});

test("authenticated allowlisted requests are allowed", () => {
  assert.equal(decideAuthorization("/api/rpp/targets", "operator@example.com", env), "allow");
  assert.equal(decideAuthorization("/rpp", "viewer@example.com", env), "allow");
});

test("unauthenticated or unlisted API requests receive a JSON 401 decision", () => {
  assert.equal(decideAuthorization("/api/rpp/targets", null, env), "api-unauthorized");
  assert.equal(decideAuthorization("/api/rpp/apply-exclusion", "unknown@example.com", env), "api-unauthorized");
});

test("unauthenticated pages redirect while login stays public", () => {
  assert.equal(decideAuthorization("/rpp", null, env), "page-unauthorized");
  assert.equal(decideAuthorization("/login", null, env), "allow");
});
