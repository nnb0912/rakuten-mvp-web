export type RppRole = "viewer" | "operator" | "admin";
export type AuthorizationDecision = "allow" | "api-unauthorized" | "page-unauthorized";

const ROLE_RANK: Record<RppRole, number> = { viewer: 1, operator: 2, admin: 3 };

function emailSet(value: string | undefined) {
  return new Set((value ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
}

export function getRppRoleForEmail(email: string | null | undefined, env: NodeJS.ProcessEnv = process.env): RppRole | null {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return null;

  const admins = emailSet(env.AUTH_ADMIN_EMAILS ?? "n.nb0912@gmail.com");
  const operators = emailSet(env.AUTH_OPERATOR_EMAILS);
  const viewers = emailSet(env.AUTH_VIEWER_EMAILS);
  const legacyAllowed = emailSet(env.AUTH_ALLOWED_EMAILS ?? "n.nb0912@gmail.com");

  if (admins.has(normalized)) return "admin";
  if (operators.has(normalized) || legacyAllowed.has(normalized)) return "operator";
  if (viewers.has(normalized)) return "viewer";
  return null;
}

export function hasRppRole(actual: RppRole | null, required: RppRole) {
  return actual !== null && ROLE_RANK[actual] >= ROLE_RANK[required];
}

export function decideAuthorization(pathname: string, email?: string | null, env: NodeJS.ProcessEnv = process.env): AuthorizationDecision {
  if (pathname.startsWith("/login")) return "allow";
  if (getRppRoleForEmail(email, env)) return "allow";
  if (pathname.startsWith("/api/")) return "api-unauthorized";
  return "page-unauthorized";
}
