import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

// Both the pool and the DATABASE_URL read are deferred to first use. Reading env
// at module load meant importing this file was enough to bind the pool to
// whatever DATABASE_URL happened to be set at import time — which is how the
// test suite's redirect lost a race and truncated the production database.
//
// `dotenv/config` is deliberately NOT imported here. Whoever owns the process
// loads it: src/index.js, drizzle.config.js, tests/setup.js. Loading it from a
// module this deep is what let .env silently repopulate DATABASE_URL after the
// tests had already tried to override it.
let poolInstance = null;
let dbInstance = null;

function init() {
  if (poolInstance) return;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not defined");
  }

  poolInstance = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  dbInstance = drizzle(poolInstance);
}

/** Defers construction to first property access, so `pool` and `db` stay plain named exports. */
function lazy(resolve) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        init();
        const target = resolve();
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
      has(_target, prop) {
        init();
        return prop in resolve();
      },
    },
  );
}

export const pool = lazy(() => poolInstance);
export const db = lazy(() => dbInstance);
