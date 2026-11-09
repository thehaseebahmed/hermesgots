import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import App from "@/App"
import { blockProblem } from "@/components/openui/gate"
import { library } from "@/components/openui/library.tsx"
import { PROSE_RULES } from "@/components/openui/prose"
import { referenceEntries } from "@/components/openui/reference"
import { OpenUIReferencePage } from "@/routes/docs/open-ui"
import { SettingsPage } from "@/routes/settings"

import {
  Path,
  click,
  find,
  findAll,
  findText,
  json,
  missing,
  mount,
  path,
  seedSettings,
  settle,
  type,
  wordsOf,
} from "./component-kit.tsx"
import { warm } from "./openui-kit.tsx"

const screen = (
  <MemoryRouter initialEntries={["/docs/open-ui"]}>
    <Path />
    <Routes>
      <Route path="/settings" element={<p data-settings>settings</p>} />
      <Route path="docs/open-ui" element={<OpenUIReferencePage />} />
    </Routes>
  </MemoryRouter>
)

const entryOf = (name: string) => find(`[data-reference-entry="${name}"]`)
const entries = () => findAll("[data-reference-entry]")
const names = () => entries().map((entry) => entry.getAttribute("data-reference-entry") ?? "")
const drawingOf = (name: string) => entryOf(name)?.querySelector("[data-reference-drawing]")
const propsOf = (name: string) =>
  [...(entryOf(name)?.querySelectorAll("[data-reference-prop]") ?? [])].map((row) => ({
    name: row.getAttribute("data-reference-prop") ?? "",
    type: row.querySelector("[data-reference-type]")?.textContent ?? "",
    required: wordsOf(row.querySelector("dd")).endsWith("required"),
  }))

/** The type each prop is shown with, as the schema renders it — the props drift's checked-in view. */
const TYPES: Record<string, string[]> = {
  Stack: ["(Card | Table | List | Callout | Chart | Map)[]"],
  Card: ["string", "string", "(Card | Table | List | Callout | Chart | Map)[]"],
  Table: ["string[]", "(string | number)[][]", "string"],
  List: ["{ label: string, detail?: string }[]", "boolean"],
  Callout: ['"info" | "warn" | "good"', "string"],
  Chart: [
    '"bar" | "line" | "area" | "pie"',
    "{ name: string, points: { x: string, y: number }[] }[]",
    "string",
    "string",
    "string",
  ],
  Map: ["{ lat: number, lng: number, label: string, detail?: string }[]", "string"],
}

test("every component has one entry, in the library's own order", async () => {
  await warm()
  await mount(screen, async () => {
    assert.deepEqual(
      names(),
      Object.keys(library.components),
      "one entry each, as the library lists them",
    )
    for (const entry of referenceEntries())
      assert.ok(entry.example, `${entry.name} has a drawn example`)
    assert.ok(missing("[data-reference-missing]"), "so no entry is missing its drawing")
    for (const name of names()) {
      assert.ok(entryOf(name)?.querySelector("[data-reference-props]"), `${name} carries its props`)
      assert.ok(entryOf(name)?.querySelector("[data-reference-lang]"), `${name} carries its Lang`)
    }
  })
})

test("every example draws through the real library and none falls back to code", async () => {
  await warm()
  await mount(screen, async () => {
    const marker: Record<string, string> = {
      Card: "[data-slot=card]",
      Table: "table",
      List: "ul",
      Callout: "[data-slot=alert]",
      Chart: "[data-slot=chart]",
      Map: "[data-slot=map]",
    }
    for (const name of names()) {
      const drawing = drawingOf(name)
      assert.ok(drawing, `${name} has a drawing`)
      assert.equal(
        drawing.querySelector("[data-md-code]"),
        null,
        `${name} did not fall back to code`,
      )
      assert.ok(drawing.children.length > 0, `${name} drew something`)
      const expected = marker[name]
      if (expected) assert.ok(drawing.querySelector(expected), `${name} drew its own component`)
    }

    for (const name of names()) {
      const code = entryOf(name)?.querySelector("[data-reference-lang] [data-md-code]")
      assert.ok(code, `${name} shows its Lang`)
      const source = code.querySelector("pre")?.textContent ?? ""
      assert.ok(source.includes("root = Stack("), `${name}'s Lang is the root-first source shown`)
      assert.equal(blockProblem(source), null, `${name}'s Lang parses`)
    }
  })
})

test("an entry's props, required marks and enumerations are the schema's", async () => {
  await warm()
  const schema = library.toJSONSchema()
  const defs = (schema.$defs ?? {}) as Record<
    string,
    { properties?: Record<string, unknown>; required?: string[] }
  >
  await mount(screen, async () => {
    for (const name of names()) {
      const def = defs[name]
      assert.ok(def, `${name} has a schema definition`)
      assert.deepEqual(
        propsOf(name).map((prop) => prop.name),
        Object.keys(def.properties ?? {}),
        `${name}'s props are the schema's, in its order`,
      )
      for (const prop of propsOf(name))
        assert.equal(
          prop.required,
          (def.required ?? []).includes(prop.name),
          `${name}.${prop.name}'s mark is the schema's`,
        )
      assert.deepEqual(
        propsOf(name).map((prop) => prop.type),
        TYPES[name],
        `${name}'s types`,
      )
    }

    assert.deepEqual(
      propsOf("Callout").map((prop) => prop.type),
      ['"info" | "warn" | "good"', "string"],
      "a tone's values are the schema's enumeration",
    )
    assert.equal(
      propsOf("Stack").some((prop) => prop.name === "title"),
      false,
      "a prop the schema does not declare never appears",
    )
  })
})

test("each entry names where its component may sit, from the schema's own children union", async () => {
  await warm()
  await mount(screen, async () => {
    assert.equal(
      entryOf("Card")?.querySelector("[data-reference-parents]")?.textContent,
      "Inside Stack",
      "a card nests in the stack",
    )
    assert.equal(
      entryOf("Chart")?.querySelector("[data-reference-parents]")?.textContent,
      "Inside Stack, Card",
      "a chart nests where its parent's union accepts it",
    )
    assert.equal(
      entryOf("Stack")?.querySelector("[data-reference-parents]")?.textContent,
      "The root of every block",
      "the library's root names itself rather than a parent",
    )
  })
})

test("the rules the schema cannot express are the module's, once each", async () => {
  await warm()
  const onScreen = () => wordsOf(document.body)
  await mount(screen, async () => {
    for (const rule of PROSE_RULES) {
      const words = rule.listed ?? rule.gloss
      if (words) assert.ok(onScreen().includes(words), `the screen says "${words}"`)
    }
    const tableRule = PROSE_RULES.find((rule) => rule.component === "Table")?.listed
    assert.ok(tableRule, "the module lists the table's rule")
    assert.ok(onScreen().includes(tableRule), "a table's plain-text rule is the prompt's sentence")
  })
})

test("a pasted block draws, and its query calls nothing", async () => {
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return json({})
  }) as unknown as typeof fetch
  await warm()
  await mount(screen, async () => {
    const field = find("#openui-playground")
    await type(
      field,
      ["root = Stack([card])", 'card = Card("Pasted", "It drew.")', 'ignored = Query("home")'].join(
        "\n",
      ),
    )
    await click(findText("button", "Draw"))
    await settle()
    assert.ok(find("[data-reference-result] [data-slot=card]"), "the pasted block drew")
    assert.match(
      find("[data-reference-result]")?.textContent ?? "",
      /Pasted/,
      "with the words it was given",
    )
    assert.ok(missing("[data-reference-error]"), "a block that draws has no error")
  })
  assert.deepEqual(calls, [], "the playground calls nothing, not even for a query")
})

test("a block that does not parse says why in words, beside its source", async () => {
  await warm()
  await mount(screen, async () => {
    await type(find("#openui-playground"), ["root = Stack([card])", 'card = Nope("x")'].join("\n"))
    await click(findText("button", "Draw"))
    await settle()
    const error = find("[data-reference-error]")
    assert.ok(error, "the error is drawn in words")
    assert.match(error.textContent ?? "", /Unknown component "Nope"/, "in the library's own words")
    assert.ok(
      find("[data-reference-result] [data-md-code]"),
      "the source it was given sits beneath it as code",
    )
    assert.ok(missing("[data-reference-result] [data-slot=card]"), "and no empty frame stands in the drawing's place")
  })
})

test("a block with no root is told what is missing, not given a diagnostic", async () => {
  await warm()
  await mount(screen, async () => {
    await type(find("#openui-playground"), "hello there")
    await click(findText("button", "Draw"))
    await settle()
    assert.match(
      find("[data-reference-error]")?.textContent ?? "",
      /no root = Stack\(\.\.\.\) to draw/,
      "the reader is told the line the block needs",
    )
  })
})

test("the playground keeps nothing: a remount is empty", async () => {
  await warm()
  const stored = () => Object.keys(localStorage).sort()
  const before = stored()
  await mount(screen, async () => {
    await type(find("#openui-playground"), 'root = Stack([c])\nc = Card("Kept?")')
    await click(findText("button", "Draw"))
    await settle()
    assert.ok(find("[data-reference-result]"), "the block drew")
  })
  assert.deepEqual(stored(), before, "nothing was written to this device")
  await mount(screen, async () => {
    const field = find("#openui-playground") as HTMLTextAreaElement | null
    assert.equal(field?.value, "", "the field is empty again")
    assert.ok(missing("[data-reference-result]"), "and nothing is drawn from the last visit")
  })
})

test("the screen is behind the setup gate every other screen passes through", async () => {
  globalThis.fetch = (async () => json({ error: { message: "no route" } }, 404)) as typeof fetch
  await seedSettings({ onboarded: false })
  await mount(
    <MemoryRouter initialEntries={["/docs/open-ui"]}>
      <App />
    </MemoryRouter>,
    async () => {
      await settle()
      assert.ok(missing("[data-reference-entry]"), "no entry is drawn before setup")
      assert.ok(missing("[data-reference-playground]"), "nor the playground")
    },
  )
})

test("Developer offers the reference, and its back link goes to Developer", async () => {
  globalThis.fetch = (async () => json({ error: { message: "no route" } }, 404)) as typeof fetch
  await seedSettings({ developer: true })
  await mount(
    <MemoryRouter initialEntries={["/settings/developer"]}>
      <Path />
      <Routes>
        <Route path="/settings/:section?" element={<SettingsPage />} />
        <Route path="docs/open-ui" element={<OpenUIReferencePage />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      await settle()
      await click(find('a[href="/docs/open-ui"]'))
      assert.equal(path(), "/docs/open-ui", "the row opens the reference")
      assert.ok(find("[data-reference-playground]"), "and the screen draws")
      await click(find('a[aria-label="Back to Developer"]'))
      assert.equal(path(), "/settings/developer", "and Back returns to Developer")
    },
  )
})

test("Settings no longer offers the reference", async () => {
  globalThis.fetch = (async () => json({ error: { message: "no route" } }, 404)) as typeof fetch
  await seedSettings()
  await mount(
    <MemoryRouter initialEntries={["/settings"]}>
      <Path />
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      await settle()
      assert.ok(missing('a[href="/docs/open-ui"]'), "the menu row is gone")
    },
  )
})
