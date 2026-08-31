export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/((?!api/auth|api/rpp/targets|api/rpp/experiments|api/rpp/meta|api/rpp/recommendations|api/rpp/sync-snapshot|api/rpp/budget-settings|api/rpp/auto-adjustment-settings|api/rpp/regenerate-recommendations|api/rpp/export-remove-setting-candidates|api/rpp/validate-remove-setting-candidates|api/rpp/apply-exclusion|api/rpp/exclusion-jobs|rpp|_next/static|_next/image|favicon.ico).*)"],
};
