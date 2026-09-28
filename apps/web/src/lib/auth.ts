import type { NextAuthOptions, User } from "next-auth";
import type { JWT } from "next-auth/jwt";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";

interface GoogleAccount {
  provider: string;
  id_token?: string;
}

const mockGoogleAuthEnabled = process.env.E2E_MOCK_GOOGLE_OAUTH === "true";

export const authOptions: NextAuthOptions = {
  providers: [
    ...(mockGoogleAuthEnabled
      ? [
          CredentialsProvider({
            id: "google-mock",
            name: "Google",
            credentials: {
              email: { label: "Email", type: "email" },
              name: { label: "Name", type: "text" },
            },
            async authorize(credentials) {
              const email = credentials?.email?.trim() || "e2e-player@example.com";
              const name = credentials?.name?.trim() || "E2E Player";

              return {
                id: email,
                email,
                name,
                mockIdToken: `e2e:${email}:${name}`,
              } as User;
            },
          }),
        ]
      : []),
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      checks: ["pkce", "state"],
      authorization: {
        params: {
          code_challenge_method: "S256",
        },
      },
    }),
  ],

  callbacks: {
    async signIn({ user, account }) {
      // After Google OAuth, register user in our API and get a JWT
      try {
        const idToken =
          account?.provider === "google-mock"
            ? user.mockIdToken
            : (account as GoogleAccount | null)?.id_token;
        if (!idToken) return false;

        const response = await fetch(
          `${process.env.NEXTAUTH_API_URL ?? process.env.NEXT_PUBLIC_API_URL}/auth/google/callback`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              idToken,
            }),
          }
        );

        if (!response.ok) return false;

        const data = (await response.json()) as { token: string };
        user.apiToken = data.token;
        return true;
      } catch {
        return false;
      }
    },

    async jwt({ token, user }) {
      if (user?.apiToken) {
        token.apiToken = user.apiToken;
      }
      return token;
    },

    async session({ session, token }) {
      session.apiToken = token.apiToken;
      return session;
    },
  },

  pages: {
    signIn: "/login",
    error: "/login",
  },

  session: {
    strategy: "jwt",
    maxAge: 7 * 24 * 60 * 60, // 7 days
  },

  cookies: {
    sessionToken: {
      name: `__Secure-next-auth.session-token`,
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
  },

  secret: process.env.NEXTAUTH_SECRET,
};
