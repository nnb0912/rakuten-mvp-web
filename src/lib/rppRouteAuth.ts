import { auth } from "@/auth";
import { getRppRoleForEmail, hasRppRole, type RppRole } from "@/lib/authAccess";

export type RppRouteAccess =
  | { ok: true; email: string; role: RppRole }
  | { ok: false; response: Response };

export async function requireRppRole(required: RppRole): Promise<RppRouteAccess> {
  const session = await auth();
  const email = session?.user?.email?.trim().toLowerCase() ?? "";
  const role = getRppRoleForEmail(email);

  if (!email || !role) {
    return { ok: false, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
  }
  if (!hasRppRole(role, required)) {
    return { ok: false, response: Response.json({ error: "forbidden", requiredRole: required }, { status: 403 }) };
  }
  return { ok: true, email, role };
}
