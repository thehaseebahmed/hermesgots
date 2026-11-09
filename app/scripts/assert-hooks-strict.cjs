/**
 * `node:assert/strict` for the component tier: the strict module with every assertion wrapped by
 * `assert-hooks.cjs`, so an element argument is a short string before Node inspects it.
 *
 * The names are assigned one per line rather than copied in a loop: a CommonJS module's named exports
 * are what `cjs-module-lexer` reads off the source, so `import { equal } from "node:assert/strict"`
 * sees exactly the properties this file writes down.
 */
const { wrapAssertion } = require("./assert-hooks.cjs")

const assert = wrapAssertion(require("node:assert/strict"))

module.exports = assert
module.exports.AssertionError = assert.AssertionError
module.exports.CallTracker = assert.CallTracker
module.exports.Assert = assert.Assert
module.exports.strict = assert.strict
module.exports.ok = assert.ok
module.exports.fail = assert.fail
module.exports.equal = assert.equal
module.exports.notEqual = assert.notEqual
module.exports.deepEqual = assert.deepEqual
module.exports.notDeepEqual = assert.notDeepEqual
module.exports.deepStrictEqual = assert.deepStrictEqual
module.exports.notDeepStrictEqual = assert.notDeepStrictEqual
module.exports.partialDeepStrictEqual = assert.partialDeepStrictEqual
module.exports.strictEqual = assert.strictEqual
module.exports.notStrictEqual = assert.notStrictEqual
module.exports.match = assert.match
module.exports.doesNotMatch = assert.doesNotMatch
module.exports.throws = assert.throws
module.exports.rejects = assert.rejects
module.exports.doesNotThrow = assert.doesNotThrow
module.exports.doesNotReject = assert.doesNotReject
module.exports.ifError = assert.ifError
