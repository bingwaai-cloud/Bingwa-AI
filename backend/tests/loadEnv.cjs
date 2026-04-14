// Loaded by jest setupFiles — runs inside each worker before any test module.
// Using CJS (not ESM) to guarantee synchronous execution.
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })
