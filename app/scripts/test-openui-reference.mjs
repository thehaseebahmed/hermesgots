import assert from "node:assert/strict"
import test from "node:test"

import { referenceEntries } from "../src/lib/openui-reference.ts"

/** The shape `library.toJSONSchema()` publishes, cut down to the props these cases read. */
const schema = {
  $defs: {
    Stack: {
      type: "object",
      properties: { children: { type: "array", items: { $ref: "#/$defs/Things" } } },
      required: ["children"],
      description: "A column of blocks.",
    },
    Things: {
      anyOf: [{ $ref: "#/$defs/Card" }, { $ref: "#/$defs/Callout" }, { $ref: "#/$defs/Table" }],
    },
    Card: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        children: { type: "array", items: { $ref: "#/$defs/Things" } },
      },
      required: ["title"],
      description: "Title, text, then children.",
    },
    Callout: {
      type: "object",
      properties: {
        tone: { type: "string", enum: ["info", "warn"] },
        text: { type: "string" },
      },
      required: ["tone", "text"],
    },
    Table: {
      type: "object",
      properties: {
        columns: { type: "array", items: { type: "string" } },
        rows: {
          type: "array",
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { label: { type: "string" }, detail: { type: "string" } },
              required: ["label"],
            },
          },
        },
        caption: { type: "string" },
      },
      required: ["columns", "rows"],
    },
  },
}

const components = ["Stack", "Card", "Callout", "Table"]
const examples = Object.fromEntries(components.map((name) => [name, `root = ${name}(...)`]))

const entries = () => referenceEntries({ components, root: "Stack", schema, examples })

test("the entries are the library's components, in the order it registers them", () => {
  assert.deepEqual(
    entries().map((entry) => entry.name),
    components,
    "never alphabetical, never a roster of the screen's own",
  )
})

test("a component's props are the schema's, in its order, with its marks", () => {
  const [, card, callout, table] = entries()
  assert.deepEqual(
    card.props,
    [
      { name: "title", type: "string", required: true },
      { name: "body", type: "string", required: false },
      { name: "children", type: "(Card | Callout | Table)[]", required: false },
    ],
    "every declared prop, and the children union by its members",
  )
  assert.deepEqual(
    callout.props,
    [
      { name: "tone", type: '"info" | "warn"', required: true },
      { name: "text", type: "string", required: true },
    ],
    "an enumeration keeps the schema's own values",
  )
  assert.deepEqual(
    table.props.map((prop) => prop.type),
    ["string[]", "{ label: string, detail?: string }[][]", "string"],
    "arrays of arrays and object elements keep their shapes",
  )
})

test("a component's description and example are the library's and the screen's", () => {
  const [stack, card, callout] = entries()
  assert.equal(stack.description, "A column of blocks.", "the library's words")
  assert.equal(callout.description, "", "no invented gloss")
  assert.equal(card.example, "root = Card(...)", "the example the screen hands it")
  assert.equal(
    referenceEntries({ components, root: "Stack", schema, examples: {} })[0].example,
    "",
    "a component without an example says so rather than borrowing one",
  )
})

test("the parents are the components whose children union accepts it", () => {
  const [stack, card, callout] = entries()
  assert.deepEqual(card.parents, ["Stack"], "a card nests in the stack")
  assert.deepEqual(callout.parents, ["Stack", "Card"], "both unions accept a callout")
  assert.deepEqual(stack.parents, [], "the root nests in nothing")
})

test("the root is the one the library names, not the one with no parents", () => {
  const [stack] = entries()
  assert.equal(stack.root, true, "the library's root says so")
  assert.equal(entries().filter((entry) => entry.root).length, 1, "exactly one root")
  assert.equal(
    referenceEntries({ components, root: "Card", schema, examples })[1].root,
    true,
    "a root renamed in the library moves the entry with it",
  )
})

test("a def the library does not register is a shape, not a component", () => {
  // `Things` is the children union, and has no entry or parent of its own; a component whose name
  // begins with an underscore is still a component, whatever zod might have generated for it.
  const named = {
    ...schema,
    $defs: {
      ...schema.$defs,
      _Hidden: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
      Stack: {
        ...schema.$defs.Stack,
        properties: {
          children: {
            type: "array",
            items: { anyOf: [{ $ref: "#/$defs/_Hidden" }, { $ref: "#/$defs/Card" }] },
          },
        },
      },
    },
  }
  const [stack, hidden] = referenceEntries({
    components: ["Stack", "_Hidden", "Card"],
    root: "Stack",
    schema: named,
    examples,
  })
  assert.equal(stack.props[0].type, "(_Hidden | Card)[]", "a registered name stays a name")
  assert.deepEqual(hidden.parents, ["Stack"], "and the component takes its place in the union")
})

test("a nullable and a constant keep the type the schema declares", () => {
  const nullable = {
    $defs: {
      Stack: {
        type: "object",
        properties: {
          value: { type: ["string", "null"] },
          fixed: { const: "one" },
          choice: { oneOf: [{ type: "string" }, { type: "number" }] },
        },
        required: ["value", "fixed", "choice"],
      },
    },
  }
  assert.deepEqual(
    referenceEntries({ components: ["Stack"], root: "Stack", schema: nullable, examples })
      .at(0)
      .props.map((prop) => prop.type),
    ["string | null", '"one"', "string | number"],
    "nothing is flattened to any",
  )
})
