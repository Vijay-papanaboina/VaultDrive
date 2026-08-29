import { betterAuth } from "better-auth";
import Database from "better-sqlite3";

export const auth = betterAuth({
  database: new Database("./database.sqlite"),
  baseURL: process.env.BETTER_AUTH_URL!,
  secret: process.env.BETTER_AUTH_SECRET!,
  socialProviders: {
    google: {
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
      scope: [
        "openid",
        "email",
        "profile",
        // Editing the existing CLI-created vault files requires write access
        // to files that were not necessarily created by this web app.
        "https://www.googleapis.com/auth/drive",
      ],
      accessType: "offline",
      prompt: "consent",
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    cookieCache: {
      enabled: true,
      maxAge: 60 * 60 * 24, // 1 day
    },
  },
});

export type Session = typeof auth.$Infer.Session;
