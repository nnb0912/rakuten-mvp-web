import assert from "node:assert/strict";
import test from "node:test";
import { buildGoogleOAuthProvider } from "./googleOAuthProvider.ts";

test("Google OAuthは公式endpointを明示しstateとPKCEを維持する", () => {
  const provider = buildGoogleOAuthProvider("client-id", "client-secret");
  assert.equal(provider.type, "oauth");
  assert.deepEqual(provider.checks, ["pkce", "state"]);
  assert.equal(typeof provider.authorization === "object" && provider.authorization.url, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(provider.token, "https://oauth2.googleapis.com/token");
  assert.equal(provider.userinfo, "https://openidconnect.googleapis.com/v1/userinfo");
});
