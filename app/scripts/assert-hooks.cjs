/**
 * The component tier's `node:assert`: the real module, with every assertion wrapped so an argument
 * that is a DOM element reaches Node as a short string instead.
 *
 * `assert.equal(element, null)` builds its failure by inspecting both arguments to depth 1000, and a
 * mounted element carries React's fiber graph — the diff walks the whole component tree, growing the
 * worker to gigabytes until the kernel kills it, and the assertion's own message never prints. The
 * shim is the boundary that cannot be spelled around: whatever a test writes, and whatever helper it
 * hands the element to, Node's inspect only ever sees `[element <div data-band="rooms"> #7]`.
 *
 * `component-loader.mjs` maps both `node:assert` and `node:assert/strict` here. Only an ESM import is
 * intercepted, so this file's own `require` is the real module.
 */
const real = require("node:assert")

/** A label long enough to name the element and short enough to read in a failure. */
const LABEL_MAX = 80

/**
 * A DOM node, which is all the scrub needs to know: an object with a numeric `nodeType` and a string
 * `nodeName`. A React element is a plain object without either, so it passes through. A getter that
 * throws is not an element either — reading it must not turn the assertion into a TypeError.
 */
function isElement(value) {
  if (value === null || typeof value !== "object") return false
  try {
    return typeof value.nodeType === "number" && typeof value.nodeName === "string"
  } catch {
    return false
  }
}

/**
 * The number a node keeps for the life of the process. Two nodes with the same tag and the same
 * attributes are still two nodes, and `assert.notStrictEqual(scroller, otherScroller)` has to go on
 * saying so once both sides are labels.
 */
const identities = new WeakMap()
let seen = 0

function identityOf(node) {
  const known = identities.get(node)
  if (known !== undefined) return known
  seen += 1
  identities.set(node, seen)
  return seen
}

/** `[element <div data-band="rooms"> #7]`: the tag, up to two attributes, and the node's identity. */
function labelOf(node) {
  const closing = ` #${identityOf(node)}]`
  const room = LABEL_MAX - "[element ".length - 1 - closing.length
  let tag = `<${node.nodeName.toLowerCase()}`
  const attributes = node.attributes
  if (attributes && typeof attributes.length === "number") {
    for (let index = 0; index < attributes.length && index < 2; index += 1) {
      const attribute = attributes.item ? attributes.item(index) : attributes[index]
      if (!attribute) continue
      const text = String(attribute.value).replace(/"/g, "'")
      const pair = ` ${attribute.name}="${text}"`
      if (tag.length + pair.length > room) break
      tag += pair
    }
  }
  const inner = tag.length > room ? `${tag.slice(0, Math.max(0, room - 1))}…` : tag
  return `[element ${inner}>${closing}`
}

/** An array member by member, and the same array back when it held nothing to scrub. */
function scrubArray(list) {
  let changed = false
  const next = list.map((member) => {
    const scrubbed = scrub(member)
    if (scrubbed !== member) changed = true
    return scrubbed
  })
  return changed ? next : list
}

function scrub(value) {
  if (isElement(value)) return labelOf(value)
  if (Array.isArray(value)) return scrubArray(value)
  return value
}

// A function that is a class — `AssertionError`, `CallTracker`, `Assert` — is not an assertion and
// cannot be called without `new`, so it is passed through unbuilt.
function isClass(candidate) {
  return /^\s*class\b/.test(Function.prototype.toString.call(candidate))
}

// `assert.strict` is the strict module itself, so a wrapper built for it is what its own `strict`
// answers with, rather than a second wrapper built forever.
const wrappedBy = new WeakMap()

/**
 * The same assertion function, with every argument scrubbed, carrying the real one's own properties:
 * `name` and `length` for a failure's message, `strict` and the rest for a caller that reaches through.
 */
function wrapAssertion(source) {
  const known = wrappedBy.get(source)
  if (known) return known
  const wrapper = function (...args) {
    return source.apply(this, args.map(scrub))
  }
  wrappedBy.set(source, wrapper)
  for (const key of Object.getOwnPropertyNames(source)) {
    if (key === "prototype") continue
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (!descriptor) continue
    const value = descriptor.value
    const copy =
      typeof value === "function" && value !== real.AssertionError && !isClass(value)
        ? wrapAssertion(value)
        : value
    Object.defineProperty(wrapper, key, { ...descriptor, value: copy })
  }
  return wrapper
}

module.exports = wrapAssertion(real)
// `assert-hooks-strict.cjs` is the same wrapper around the strict module, and it is reached through
// this one so the label and the guard live in one place. Non-enumerable, so a wrapped assert still
// inspects as the real one's property set.
Object.defineProperty(module.exports, "wrapAssertion", {
  value: wrapAssertion,
  enumerable: false,
})
