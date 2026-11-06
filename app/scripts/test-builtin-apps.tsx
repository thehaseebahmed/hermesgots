/**
 * The built-in apps the plugin ships (`plugin/openui/apps/`), parsed through the library that draws
 * them: a page naming a component or prop the library lacks fails here, not in someone's app.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { appParser } from "../src/components/openui/library.tsx"
import { consentOf } from "../src/lib/app-build.ts"

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "openui", "apps")
const ID_LINE = /^\s*#\s*id:\s*([A-Za-z0-9][A-Za-z0-9_-]{0,63})\s*(?:\n|$)/

type Entry = { version: number; title: string; library_version: string; pages: string[] }
const manifest = JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8")) as {
  set_version: number
  apps: Record<string, Entry>
}

function pagesOf(entry: Entry) {
  return entry.pages.map((file) => {
    const source = readFileSync(join(BUNDLE, file), "utf8")
    return { file, source, id: ID_LINE.exec(source)?.[1] ?? "root" }
  })
}

test("the manifest names a set version and a version per app", () => {
  assert.ok(Number.isInteger(manifest.set_version) && manifest.set_version > 0)
  assert.ok(Object.keys(manifest.apps).length > 0)
  for (const [key, entry] of Object.entries(manifest.apps)) {
    assert.ok(Number.isInteger(entry.version) && entry.version > 0, `${key} has no version`)
    assert.ok(entry.title.trim(), `${key} has no title`)
    assert.ok(entry.pages.length > 0, `${key} lists no pages`)
  }
})

for (const [key, entry] of Object.entries(manifest.apps)) {
  test(`${key}: every page parses through the real library with no error`, () => {
    for (const { file, source } of pagesOf(entry)) {
      const result = appParser.parse(source)
      assert.ok(result.root, `${file} draws nothing`)
      assert.deepEqual(
        result.meta.errors.filter((error) => error.severity !== "warning"),
        [],
        `${file} fails the library`,
      )
      assert.deepEqual(result.meta.unresolved, [], `${file} leaves a reference unresolved`)
      assert.match(source, /Sample data/, `${file} does not say its data is sample`)
    }
  })

  test(`${key}: page ids are distinct, the first is the root, and every link resolves`, () => {
    const pages = pagesOf(entry)
    const ids = pages.map((page) => page.id)
    assert.equal(new Set(ids).size, ids.length, "two pages share an id")
    assert.equal(ids[0], "root")
    for (const { file, source } of pages) {
      for (const [, target] of source.matchAll(/Link\("(?:[^"\\]|\\.)*",\s*"([^"]+)"\)/g))
        assert.ok(ids.includes(target), `${file} links to ${target}, which the app lacks`)
    }
  })
}

const SERVERS = { home: "homeassistant", gtd: "todoist" } as const

for (const [key, server] of Object.entries(SERVERS)) {
  test(`${key}: every page reads a ${server} tool and declares the sample it draws without one`, () => {
    for (const { file, source } of pagesOf(manifest.apps[key])) {
      const queries = [...source.matchAll(/Query\("([^"]+)",\s*(\{.*?\}),\s*\{(.+)\}\)/g)]
      assert.ok(queries.length > 0, `${file} reads nothing`)
      for (const [, name, , defaults] of queries) {
        assert.ok(name.startsWith(`${server}.`), `${file} reads ${name}`)
        assert.match(defaults, /notice: "Sample data/, `${file} declares no sample notice`)
      }
    }
  })
}

test("gtd: the root completes a task through a Todoist mutation that shows pending", () => {
  const root = pagesOf(manifest.apps.gtd)[0].source
  assert.match(root, /Mutation\("todoist\.complete-task"/)
  assert.match(root, /Button\(.*@Run\(done\).*done\.status == "loading"\)/)
})

test("gtd and home share the library but not a server or a verb", () => {
  const consent = (key: string) => consentOf(pagesOf(manifest.apps[key]).map((page) => page.source))
  const [home, gtd] = [consent("home"), consent("gtd")]
  const used = (c: typeof home) => [...c.reads, ...c.acts]
  assert.deepEqual(
    used(gtd).filter((tool) => used(home).includes(tool)),
    [],
  )
  assert.deepEqual(gtd.acts, ["todoist.complete-task"])
  assert.ok(used(gtd).every((tool) => tool.startsWith("todoist.")))
})
