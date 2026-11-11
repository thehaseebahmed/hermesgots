#!/usr/bin/env node
/**
 * The mechanical half of the component-ux skill: find the shapes that mean a primitive was skipped.
 *
 *   node .agents/skills/component-ux/scripts/audit.mjs                  # the whole app
 *   node .agents/skills/component-ux/scripts/audit.mjs src/routes       # one directory
 *   node .agents/skills/component-ux/scripts/audit.mjs $(git diff --name-only main)  # a diff
 *   node .agents/skills/component-ux/scripts/audit.mjs --strict         # exit 1 on any finding
 *
 * It reads intent out of nothing: every hit is a question for the reader, and SKILL.md's three
 * verdicts (fit it, make it a rule, make it an exception) are how it gets answered. A regex on a
 * line cannot see a className built across lines, so a clean run is not a clean bill.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const APP = resolve(process.cwd().endsWith("app") ? process.cwd() : join(process.cwd(), "app"))
const SRC = join(APP, "src")

/** Files that own the shape they are being checked for. */
const OWNERS = {
  bar: ["src/components/chat/chat-header.tsx", "src/components/settings-chrome.tsx"],
  column: ["src/components/settings-chrome.tsx", "src/components/list-foot.tsx"],
  chipRow: ["src/components/chip.tsx", "src/components/repos.tsx"],
  search: [
    "src/components/search-field.tsx",
    "src/components/item-list.tsx",
    "src/components/list-foot.tsx",
  ],
  spinner: ["src/components/ui/spinner.tsx", "src/components/ui/sonner.tsx"],
  card: ["src/components/chat/session-cards.tsx"],
  confirm: ["src/components/settings-chrome.tsx", "src/components/confirm-destructive.tsx"],
  empty: [],
  bubble: ["src/components/chat/user-bubble.tsx", "src/components/room/room-chat.tsx"],
}

const RULES = {
  bar: "C1 bar — a hand-written sticky bar; ChatHeader (pinned) is the app's bar (ADR 0140)",
  column: "C2 column — a hand-written page column; Screen owns the centred 672px column",
  chipRow:
    "C3 chip row — a hand-written sideways strip; ChipRow is the strip (44px, no scrollbar), PILL the composer row",
  search: "C4 search — a search field drawn by hand; SearchField owns the target, the X and Escape",
  spinner: "C5 loading — a private spinner; Spinner turns beside the words it belongs to",
  card: "C6 card — an ad-hoc card; Card, Group or CARD_BASE is the surface, and radius is not a class",
  confirm:
    "C7 confirm — an AlertDialog drawn here: a yes-or-no question is ConfirmDestructive; a form or a three-way question is an exception to name",
  empty: "C8 empty — a hand-drawn empty state; EmptyState is the extraction (three copies already)",
  bubble: "C9 bubble — ui/bubble outside UserBubble; the user's words wear the markdown bubble (ADR 0083)",
  dead: "C10 dead — a component with no importer; delete it or give it a caller",
}

const args = process.argv.slice(2)
const strict = args.includes("--strict")
const paths = args.filter((one) => !one.startsWith("--"))

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (entry === "node_modules" || entry === "dist") continue
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(tsx?|jsx?)$/.test(entry)) out.push(full)
  }
  return out
}

const all = walk(SRC).map((p) => ({
  path: p,
  rel: relative(APP, p),
  text: readFileSync(p, "utf8"),
}))

/** Every file that imports `target`, by relative path. Lazy `import()` counts: the chat route loads
 * most of its screens that way, and a component nobody statically imports is not dead. */
function importersOf(target) {
  const base = target.replace(/\.(tsx?|jsx?)$/, "")
  return all.filter((file) => {
    if (file.rel === target) return false
    const dir = target.slice(0, target.lastIndexOf("/"))
    const specs = [
      ...file.text.matchAll(/from\s+["']([^"']+)["']/g),
      ...file.text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
    ]
    return specs.some((m) => {
      const spec = m[1]
      const resolved = spec.startsWith("@/")
        ? `src/${spec.slice(2)}`
        : spec.startsWith(".")
          ? join(dir, spec)
          : null
      return resolved !== null && resolved.replace(/\.(tsx?|jsx?)$/, "") === base
    })
  })
}

const findings = []
const seen = new Set()
function hit(rule, file, line, note) {
  const key = `${rule}|${file}|${line}`
  if (seen.has(key)) return
  seen.add(key)
  findings.push({ rule, file, line, note })
}

const scanned = paths.length
  ? all.filter((f) =>
      paths.some((p) => {
        const abs = resolve(APP, p)
        return f.path === abs || f.rel === p || f.path.startsWith(abs + "/")
      }),
    )
  : all

for (const file of scanned) {
  const lines = file.text.split("\n")
  lines.forEach((line, index) => {
    const n = index + 1
    if (!OWNERS.bar.includes(file.rel) && /sticky top-0 z-10 bg-background\/80/.test(line))
      hit("bar", file.rel, n, "sticky bar written here")
    if (!OWNERS.column.includes(file.rel) && /mx-auto flex w-full max-w-2xl/.test(line))
      hit("column", file.rel, n, "page column written here")
    if (!OWNERS.chipRow.includes(file.rel) && /\[scrollbar-width:none\]/.test(line))
      hit("chipRow", file.rel, n, "sideways strip written here")
    if (!OWNERS.spinner.includes(file.rel) && /animate-spin/.test(line))
      hit("spinner", file.rel, n, line.trim().slice(0, 80))
    if (
      !OWNERS.card.includes(file.rel) &&
      /rounded-(2xl|3xl)\s+border\s+bg-card|rounded-(2xl|3xl)\s+bg-card\s+border/.test(line)
    )
      hit("card", file.rel, n, "ad-hoc card surface")
    if (OWNERS.card.includes(file.rel) === false && /<Card[^>]*rounded-3xl/.test(line))
      hit("card", file.rel, n, "Card's radius overridden to match a group")
    if (/size-16 items-center justify-center rounded-full bg-primary\/10/.test(line))
      hit("empty", file.rel, n, "empty-state disc")
    if (!OWNERS.bubble.includes(file.rel) && /components\/ui\/bubble/.test(line))
      hit("bubble", file.rel, n, "bubble imported directly")
  })

  // A search field: a magnifier near an InputGroup, in a file that never learned SearchField.
  const drawsSearch = /SearchIcon/.test(file.text) && /InputGroup/.test(file.text)
  const usesShared =
    /from "@\/components\/item-list"/.test(file.text) && /SearchField/.test(file.text)
  if (drawsSearch && !usesShared && !OWNERS.search.includes(file.rel)) {
    const n = lines.findIndex((l) => /SearchIcon/.test(l)) + 1
    hit("search", file.rel, n || 1, "search drawn here")
  }

  if (
    !OWNERS.confirm.includes(file.rel) &&
    /from "@\/components\/ui\/alert-dialog"/.test(file.text)
  ) {
    const n = lines.findIndex((l) => /ui\/alert-dialog/.test(l)) + 1
    hit("confirm", file.rel, n || 1, "AlertDialog imported directly")
  }
}

// Dead components: a file under src/components with no importer anywhere. Only the files in scope,
// so a diff's audit does not report the whole app's orphans.
for (const file of scanned) {
  if (!file.rel.startsWith("src/components/")) continue
  if (importersOf(file.rel).length === 0) hit("dead", file.rel, 1, "no importer")
}

const order = Object.keys(RULES)
findings.sort(
  (a, b) =>
    order.indexOf(a.rule) - order.indexOf(b.rule) || a.file.localeCompare(b.file) || a.line - b.line,
)

let rule = null
for (const finding of findings) {
  if (finding.rule !== rule) {
    rule = finding.rule
    console.log(`\n${RULES[rule]}`)
  }
  console.log(`  ${finding.file}:${finding.line}  ${finding.note}`)
}

const counts = order
  .map((key) => [key, findings.filter((f) => f.rule === key).length])
  .filter(([, n]) => n > 0)
const files = `${scanned.length} file${scanned.length === 1 ? "" : "s"}`
console.log(
  `\n${findings.length} finding${findings.length === 1 ? "" : "s"} in ${files}` +
    (counts.length ? ` (${counts.map(([k, n]) => `${k} ${n}`).join(", ")})` : "") +
    "\nRead each one: fit it, make it a rule, or record it as an exception (SKILL.md).",
)
process.exit(strict && findings.length ? 1 : 0)
