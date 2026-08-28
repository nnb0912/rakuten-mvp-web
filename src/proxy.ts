export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/((?!api/auth|api/rpp/targets|api/rpp/auto-adjustment-settings|api/rpp/regenerate-recommendations|api/rpp/apply-exclusion|api/rpp/exclusion-jobs|rpp|_next/static|_next/image|favicon.ico).*)"],
};
