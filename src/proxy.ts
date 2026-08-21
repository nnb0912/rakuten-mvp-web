export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/((?!api/auth|api/rpp/targets|rpp|_next/static|_next/image|favicon.ico).*)"],
};
