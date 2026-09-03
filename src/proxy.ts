export { auth as proxy } from "@/auth";

export const config = {
  // Human-operated RPP pages and APIs must pass through Auth.js.
  // Only machine endpoints with their own Bearer-token validation stay public.
  matcher: ["/((?!api/auth|api/rpp/sync-snapshot|api/rpp/exclusion-jobs|_next/static|_next/image|favicon.ico).*)"],
};
