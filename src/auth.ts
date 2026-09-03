import NextAuth from "next-auth";
import { buildGoogleOAuthProvider } from "@/lib/googleOAuthProvider";
import { decideAuthorization, getRppRoleForEmail } from "@/lib/authAccess";

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  providers: [
    buildGoogleOAuthProvider(process.env.AUTH_GOOGLE_ID, process.env.AUTH_GOOGLE_SECRET),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async authorized({ auth, request }) {
      const decision = decideAuthorization(request.nextUrl.pathname, auth?.user?.email);
      if (decision === "allow") return true;
      if (decision === "api-unauthorized") {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return false;
    },
    async signIn({ profile }) {
      return getRppRoleForEmail(profile?.email) !== null;
    },
    async session({ session }) {
      return session;
    },
  },
});
