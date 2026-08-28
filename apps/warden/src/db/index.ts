import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set — copy .env.example to .env.local");

/* Production Postgres (CT 100) is shared by every CommandHQ app and is
 * tuned for max_connections = 50. Six apps at five connections each fits
 * with room to spare; leaving the pool unbounded does not. */
const POOL_MAX = 5;

/* Next dev reloads modules on every edit. Without stashing the client on
 * globalThis, each reload opens a fresh pool and leaks the old one until
 * Postgres starts refusing connections. */
const globalForDb = globalThis as unknown as {
  __wardenClient?: ReturnType<typeof postgres>;
};

const client =
  globalForDb.__wardenClient ??
  postgres(url, { max: POOL_MAX, onnotice: () => {} });

if (process.env.NODE_ENV !== "production") globalForDb.__wardenClient = client;

export const db = drizzle(client, { schema });
export { schema };
