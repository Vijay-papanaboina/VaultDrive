import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required to initialize the PostgreSQL database connection.");
}

const globalForDatabase = globalThis as typeof globalThis & {
  __vaultdrivePostgresPool?: Pool;
};

export const database = process.env.NODE_ENV === "development"
  ? globalForDatabase.__vaultdrivePostgresPool ??= new Pool({ connectionString })
  : new Pool({ connectionString });
