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
    },
});
