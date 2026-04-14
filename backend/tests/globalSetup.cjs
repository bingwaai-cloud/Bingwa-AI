/**
 * Jest globalSetup — runs once before all test suites in the main process.
 * Loads .env so env vars are available to all worker processes.
 */
const path = require('path')

module.exports = async function globalSetup() {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env') })
}
