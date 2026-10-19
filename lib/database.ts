import { Pool } from "pg";

function normalizeSslMode(connectionString: string): string {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    return connectionString;
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return connectionString;
  const queryStart = connectionString.indexOf("?");
  if (queryStart < 0) return connectionString;
  const fragmentStart = connectionString.indexOf("#", queryStart);
  const queryEnd = fragmentStart < 0 ? connectionString.length : fragmentStart;
  const queryParts = connectionString.slice(queryStart + 1, queryEnd).split("&");
  let lastSslModeIndex = -1;
  let sslMode: string | undefined;
  let libpqCompatibility: string | undefined;

  const decodeQueryPart = (value: string) => {
    try {
      return decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      return value;
    }
  };

  queryParts.forEach((part, index) => {
    const separator = part.indexOf("=");
    const key = decodeQueryPart(separator < 0 ? part : part.slice(0, separator));
    const value = decodeQueryPart(separator < 0 ? "" : part.slice(separator + 1));
    if (key === "sslmode") {
      lastSslModeIndex = index;
      sslMode = value;
    } else if (key === "uselibpqcompat") {
      libpqCompatibility = value;
    }
  });

  if (
    libpqCompatibility === "true" ||
    lastSslModeIndex < 0 ||
    (sslMode !== "prefer" && sslMode !== "require" && sslMode !== "verify-ca")
  ) {
    return connectionString;
  }

  // Keep the node-postgres parser on full CA and hostname verification as its legacy aliases are deprecated.
  const previous = queryParts[lastSslModeIndex];
  const separator = previous.indexOf("=");
  queryParts[lastSslModeIndex] = `${separator < 0 ? previous : previous.slice(0, separator)}=verify-full`;
  return `${connectionString.slice(0, queryStart + 1)}${queryParts.join("&")}${connectionString.slice(queryEnd)}`;
}

const configuredConnectionString = process.env.DATABASE_URL;

if (!configuredConnectionString) {
  throw new Error("DATABASE_URL is required to initialize the PostgreSQL database connection.");
}

const connectionString = normalizeSslMode(configuredConnectionString);

const globalForDatabase = globalThis as typeof globalThis & {
  __vaultdrivePostgresPool?: Pool;
};

export const database = process.env.NODE_ENV === "development"
  ? globalForDatabase.__vaultdrivePostgresPool ??= new Pool({ connectionString })
  : new Pool({ connectionString });
