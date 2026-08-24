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

  // pg-pool re-emits errors from IDLE clients onto the pool. In Node an
  // 'error' event with no listener is an unhandled exception, so a hosted
  // Postgres dropping an idle connection took the whole process down —
  // `Error: read ETIMEDOUT at Client.idleListener`, killing the poll loop and
  // every WebSocket with it. The listener EXISTING is the fix; pg has already
  // discarded the client by the time this runs, and the pool replaces it on
  // the next checkout.
  //
  // console.error, not the logger: importing logger.js here would make db.js
  // read env at import and stop being side-effect free to import, which is
  // what lets the unit suites run with no credentials in the environment.
  // This path is a rare degraded-path event at runtime, never the hot path.
  //
  // Logs `code` and `message` only — never the error object, which can carry
  // connection detail.
  poolInstance.on("error", (error) => {
    console.error(
      `[db] idle client error (${error?.code ?? "no code"}): ${error?.message ?? error}. Client discarded; pool continues.`,
    );
  });

  // The pool listener above is not enough on its own. pg-pool forwards only
  // IDLE client errors to the pool — it attaches its `idleListener` on release
  // and removes it on checkout — so an error emitted on a client that is
  // checked out or still connecting reaches no listener and crashes the
  // process anyway. That is a distinct path with a distinct stack:
  //
  //     Error: Connection terminated unexpectedly
  //       at Connection.<anonymous> (pg/lib/client.js:193)
  //     Emitted 'error' event on Client instance at:
  //       at Client._handleErrorEvent (pg/lib/client.js:411)
  //
  // Attaching a listener at connect time, and never removing it, guarantees
  // every client has one for its whole life whatever the pool is doing with
  // it. pg-pool's own idle handling is unaffected — listeners are additive.
  poolInstance.on("connect", (client) => {
    client.on("error", (error) => {
      console.error(
        `[db] client error (${error?.code ?? "no code"}): ${error?.message ?? error}. Client will be discarded; pool continues.`,
      );
    });
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
