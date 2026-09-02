import Google, { type GoogleProfile } from "next-auth/providers/google";
import type { OAuthConfig } from "next-auth/providers";

/**
 * GoogleのOIDC discovery metadataがRFC 9207のiss応答を必須扱いする一方、
 * 実際のcallbackにissが付かない場合があるため、公式OAuth endpointsを明示する。
 * state + PKCEは維持し、profileはGoogle userinfo endpointから取得する。
 */
export function buildGoogleOAuthProvider(clientId?: string, clientSecret?: string): OAuthConfig<GoogleProfile> {
  return {
    ...Google({ clientId, clientSecret }),
    type: "oauth",
    authorization: {
      url: "https://accounts.google.com/o/oauth2/v2/auth",
      params: { scope: "openid profile email", response_type: "code" },
    },
    token: "https://oauth2.googleapis.com/token",
    userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
    checks: ["pkce", "state"],
  };
}
