// Load .env so ANTHROPIC_API_KEY is available during test setup
require('dotenv').config()

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    // Strip .js extensions so ts-jest can resolve .ts source files
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: '<rootDir>/tsconfig.test.json',
      },
    ],
  },
  testMatch: ['**/tests/**/*.test.ts'],
  testTimeout: 30000, // NLP integration tests hit Claude API — allow 30s
  setupFiles: ['<rootDir>/tests/loadEnv.cjs'],
}
