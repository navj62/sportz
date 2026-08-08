import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        setupFiles: ['./tests/setup.js'],
        // Test FILES run one at a time. Two suites now TRUNCATE the same test
        // database — integration.test.js and cachedReads.test.js — and in
        // parallel they wipe each other's rows mid-test. The failures look
        // like assertion bugs but are pure cross-file interference: both files
        // pass alone and fail together. Serialising also removes the Upstash
        // contention that was intermittently failing the real-Redis suite.
        //
        // The alternative is a second test database, which is more setup than
        // a suite this size earns. Revisit if the run time becomes a problem.
        fileParallelism: false,
        // Vitest's 5s default is a unit-test budget. Several suites here do
        // real round trips to a Neon instance in ap-southeast-1 at 0.4-1s a
        // query, so a slow-but-healthy write could exceed 5s and fail as a
        // timeout — which is what it did, intermittently and on a different
        // test each run. This corrects a wrong budget rather than hiding a
        // hang: anything genuinely stuck still fails, 15s later.
        testTimeout: 20_000,
        // NOTE: `retry` is deliberately NOT set here. It is applied per suite,
        // only where a failure is provably transient network — see
        // redis.test.js and cachedReads.test.js. Retrying the integration
        // suite would have hidden the cache-staleness bug found while wiring
        // the read cache, which failed intermittently and was entirely real.
    },
});
