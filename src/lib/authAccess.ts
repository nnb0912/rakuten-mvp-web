export type AuthorizationDecision = "allow" | "api-unauthorized" | "page-unauthorized";

export function decideAuthorization(pathname: string, email?: string | null): AuthorizationDecision {
  if (pathname.startsWith("/login")) return "allow";
  if (email) return "allow";
  if (pathname.startsWith("/api/")) return "api-unauthorized";
  return "page-unauthorized";
}
