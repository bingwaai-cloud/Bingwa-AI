// Load .env so ANTHROPIC_API_KEY is available during test setup
require('dotenv').config()
const path = require('path')

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    // src/... → backend/src/...  (1-level alias so tests can import without ../ depth)
    // Strip trailing .js so ts-jest resolves the .ts source.
    '^src/(.*)\\.js$': '<rootDir>/src/$1',
    // Strip trailing .js from relative imports so ts-jest resolves .ts source files.
    // Handles any depth (./foo, ../../bar, ../../../baz, etc.).
    '^((?:\\.\\.?/).*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        // Absolute path — jest does NOT substitute <rootDir> inside transform options,
        // so a relative/literal '<rootDir>/...' string is passed verbatim to ts-jest
        // and silently falls back to the root tsconfig.json (rootDir ./src → breaks tests).
        tsconfig: path.resolve(__dirname, 'tsconfig.test.json'),
      },
    ],
  },
  testMatch: ['**/tests/**/*.test.ts'],
  testTimeout: 30000, // NLP integration tests hit Claude API — allow 30s
  // forceExit removed (WP-30): rate-limit timers drained by globalTeardown → shutdownRateLimitStores()
  setupFiles: ['<rootDir>/tests/loadEnv.cjs'],
  globalSetup: '<rootDir>/tests/globalSetup.cjs',
  globalTeardown: '<rootDir>/tests/globalTeardown.cjs',
}
