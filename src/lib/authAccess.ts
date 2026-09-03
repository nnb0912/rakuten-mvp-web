export type RppRole = "viewer" | "operator" | "admin";
export type AuthorizationDecision = "allow" | "api-unauthorized" | "page-unauthorized";

const ROLE_RANK: Record<RppRole, number> = { viewer: 1, operator: 2, admin: 3 };

function emailSet(value: string | undefined) {
  return new Set((value ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
}

function normalizedEmail(email: string | null | undefined) {
  return email?.trim().toLowerCase() || null;
}

export function isLegacyAllowedEmail(email: string | null | undefined, env: NodeJS.ProcessEnv = process.env) {
  const normalized = normalizedEmail(email);
  if (!normalized) return false;
  return emailSet(env.AUTH_ALLOWED_EMAILS ?? "n.nb0912@gmail.com").has(normalized);
}

export function getRppRoleForEmail(email: string | null | undefined, env: NodeJS.ProcessEnv = process.env): RppRole | null {
  const normalized = normalizedEmail(email);
  if (!normalized) return null;

  const admins = emailSet(env.AUTH_ADMIN_EMAILS ?? "n.nb0912@gmail.com");
  const operators = emailSet(env.AUTH_OPERATOR_EMAILS);
  const viewers = emailSet(env.AUTH_VIEWER_EMAILS);

  if (admins.has(normalized)) return "admin";
  if (operators.has(normalized) || isLegacyAllowedEmail(normalized, env)) return "operator";
  if (viewers.has(normalized)) return "viewer";
  return null;
}

export function canSignIn(email: string | null | undefined, env: NodeJS.ProcessEnv = process.env) {
  return isLegacyAllowedEmail(email, env) || getRppRoleForEmail(email, env) !== null;
}

export function hasRppRole(actual: RppRole | null, required: RppRole) {
  return actual !== null && ROLE_RANK[actual] >= ROLE_RANK[required];
}

function isRppPath(pathname: string) {
  return pathname === "/rpp" || pathname.startsWith("/rpp/") || pathname.startsWith("/api/rpp/");
}

export function decideAuthorization(pathname: string, email?: string | null, env: NodeJS.ProcessEnv = process.env): AuthorizationDecision {
  if (pathname.startsWith("/login")) return "allow";

  if (isRppPath(pathname)) {
    if (getRppRoleForEmail(email, env)) return "allow";
    return pathname.startsWith("/api/rpp/") ? "api-unauthorized" : "page-unauthorized";
  }

  // Preserve the pre-RBAC access boundary outside RPP. RPP-only accounts do not
  // gain access to the rest of the management system.
  return isLegacyAllowedEmail(email, env) ? "allow" : "page-unauthorized";
}
