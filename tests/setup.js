// Load .env HERE, before the redirect below. Vitest does not read .env itself,
// so without this TEST_DATABASE_URL is undefined at setup time, the redirect
// silently no-ops, and db/db.js — which calls dotenv/config at module load —
// ends up pointing the pool at the real DATABASE_URL. The suite then runs, and
// TRUNCATEs, against the production database. dotenv does not overwrite vars
// that are already set, so loading it here and reassigning below is safe.
import 'dotenv/config';

// Redirect DATABASE_URL to the test database before any modules are loaded.
// vitest runs setupFiles in the worker process before test file imports are
// evaluated, so db/db.js will pick up the updated env var when it first runs.
if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// Silence pino output during tests unless the caller explicitly sets LOG_LEVEL.
process.env.LOG_LEVEL ??= 'silent';
