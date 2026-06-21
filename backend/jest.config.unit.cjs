// DB-free unit config (WP-10): runs the mocked payment-provider unit suites
// without the Postgres globalSetup. The default `npm test` config also picks
// these up (testMatch **/tests/**/*.test.ts) — they mock all I/O so they pass
// with or without a database.
require('dotenv').config()
const base = require('./jest.config.cjs')

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  globalSetup: undefined,
  testMatch: ['**/tests/unit/payments/**/*.test.ts'],
}
