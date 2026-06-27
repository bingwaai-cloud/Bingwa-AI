// Jest config for NLP tests — no DB globalSetup needed.
// Inherits everything from the main config except globalSetup.
require('dotenv').config()

const base = require('./jest.config.cjs')

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  globalSetup: undefined,
  testMatch: ['**/tests/nlp/**/*.test.ts'],
  testTimeout: 120000, // NLP corpus can be slow in live mode
}
