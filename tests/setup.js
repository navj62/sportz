// Redirect DATABASE_URL to the test database before any modules are loaded.
// vitest runs setupFiles in the worker process before test file imports are
// evaluated, so db/db.js will pick up the updated env var when it first runs.
if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// Silence pino output during tests unless the caller explicitly sets LOG_LEVEL.
process.env.LOG_LEVEL ??= 'silent';
