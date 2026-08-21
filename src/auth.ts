import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const allowedEmails = new Set(
  (process.env.AUTH_ALLOWED_EMAILS ?? "n.nb0912@gmail.com")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async authorized({ auth, request }) {
      const pathname = request.nextUrl.pathname;
      if (pathname.startsWith("/login")) return true;
      return Boolean(auth?.user?.email);
    },
    async signIn({ profile }) {
      const email = profile?.email?.toLowerCase();
      return Boolean(email && allowedEmails.has(email));
    },
    async session({ session }) {
      return session;
    },
  },
});
