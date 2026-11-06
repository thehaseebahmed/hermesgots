// The Gots plugin's apps (apps.py, ADR 0099–0102), for the mock Hermes server: the list of apps a
// bot keeps, one page's source read and written, one step of undo, a built-in app's hidden mark,
// consent, and the mark a run is told the app's rules by (openui.py's `mark_app_run`, ADR 0101).
//
// The answers are the plugin's own, field for field: the `gots.app*` envelopes, `builtin-<key>`
// and `app-<12 hex>` ids, a page id that falls back to `root`, the title and page caps with their
// 413s, consent derived from what a page names rather than trusted from a request, and the 409 a
// list that moved on since a person was shown it earns.
//
// The two built-in apps are the plugin's bundle (`plugin/openui/apps/`), read off disk rather than
// copied, so the pages this mock serves are the pages that ship. They are served as a bot that
// agreed to them on another device: `tools` names what their pages call and `pending` is empty, so
// the app asks nothing on open. A read of one of their tools is answered 502 — the server behind
// the tool is not reachable from this host — which leaves the page drawing the defaults it
// declared, the sample a bot with neither Home Assistant nor Todoist shows.
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"

/** The bundle ships beside the prompt artifacts the app's own tier proves parse (`apps.py`). */
const BUNDLE = new URL("../../plugin/openui/apps/", import.meta.url)
const MANIFEST = JSON.parse(readFileSync(new URL("manifest.json", BUNDLE), "utf8"))
const LIBRARY_VERSION = Object.values(MANIFEST.apps)[0].library_version
/** `apps.PAGE_MAX_CHARS` and `apps.TITLE_MAX_CHARS`, with the refusals that name them. */
const PAGE_MAX_CHARS = 20_000
const TITLE_MAX_CHARS = 120

/** The page a build answers with: the smallest app that reads as one — a card over a table. */
export const BUILT_PAGE = [
  "# id: root",
  "root = Stack([summary, beds])",
  'summary = Card("The garden", "Three beds are ready to plant.")',
  'beds = Table(["Bed", "Sun", "Ready"], [["North", "6 h", "Yes"], ["South", "4 h", "No"], ["East", "7 h", "Yes"]], "Beds")',
].join("\n")

/** What a change to it answers: the same page, changed in the card and one row fewer. */
export const CHANGED_PAGE = [
  "# id: root",
  "root = Stack([summary, beds])",
  'summary = Card("The garden after the rain", "Two beds are ready to plant.")',
  'beds = Table(["Bed", "Sun", "Ready"], [["North", "6 h", "Yes"], ["South", "4 h", "No"]], "Beds")',
].join("\n")

/** The tools a page names (app_tools.py): reads from `Query`, acts from `Mutation`. */
const CALL = /\b(Query|Mutation)\(\s*"([^"\\]+)"/g
const TOOL = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
/** The host's own reads, which are never a tool (app_tools.py). */
const HOST_SHAPES = new Set(["usage", "routines", "projects", "sessions"])
const NONE = { reads: [], acts: [] }

function toolsOf(sources) {
  const reads = new Set()
  const acts = new Set()
  for (const source of sources)
    for (const [, kind, name] of source.matchAll(CALL))
      if (TOOL.test(name) && !HOST_SHAPES.has(name)) (kind === "Query" ? reads : acts).add(name)
  return { reads: [...reads].sort(), acts: [...acts].sort() }
}

/** What `named` holds that `agreed` does not, per group — the list a sheet asks about. */
const difference = (named, agreed) => ({
  reads: named.reads.filter((name) => !agreed.reads.includes(name)),
  acts: named.acts.filter((name) => !agreed.acts.includes(name)),
})

const ID_LINE = /^\s*#\s*id:\s*([A-Za-z0-9][A-Za-z0-9_-]{0,63})\s*$/
/** The page id a source carries, or `root` where it names none (`apps.page_id_of`). */
function idOf(source) {
  for (const line of source.split("\n")) if (line.trim()) return ID_LINE.exec(line)?.[1] ?? "root"
  return "root"
}

/** `apps._checked`: a source that is a string, isn't blank, and stays under the page cap. */
function checked(source) {
  if (typeof source !== "string" || !source.trim()) return { error: ["A page needs a source.", 400] }
  if (source.length > PAGE_MAX_CHARS)
    return {
      error: [
        `A page's source is capped at ${PAGE_MAX_CHARS} characters (the page cap); this one is ${source.length}.`,
        413,
      ],
    }
  return { source }
}

/** Every app this process keeps, by id: the store's tables, held in memory. */
const apps = new Map()
/** The sessions a build marked, so a turn is answered as an app's only where the app said so. */
const marked = new Set()
let seeded = false

/** The built-in apps, written on the first read of the list and on none after it (`apps.seed`). */
function seed() {
  if (seeded) return
  seeded = true
  const at = Date.now()
  Object.entries(MANIFEST.apps).forEach(([key, entry], index) => {
    const pages = entry.pages.map((file) => {
      const source = readFileSync(new URL(file, BUNDLE), "utf8").trimEnd()
      return { id: idOf(source), source, previous: null }
    })
    apps.set(`builtin-${key}`, {
      id: `builtin-${key}`,
      title: entry.title,
      library_version: entry.library_version,
      builtin: key,
      hidden: false,
      created_at: at - (Object.keys(MANIFEST.apps).length - index) * 1000,
      // Agreed already, as a second device reads a first device's answer: nothing to ask on open.
      consent: toolsOf(pages.map((page) => page.source)),
      pages,
    })
  })
}

const named = (app) => toolsOf(app.pages.map((page) => page.source))

const summary = (app) => ({
  id: app.id,
  title: app.title,
  library_version: app.library_version,
  pages: app.pages.map((page) => page.id),
  builtin: app.builtin,
  hidden: app.hidden,
  update: false,
  tools: app.consent,
  pending: difference(named(app), app.consent),
})

const answer = (app, page) => ({
  id: page.id,
  app_id: app.id,
  source: page.source,
  undoable: page.previous !== null,
})

const newestFirst = (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)

/** Whether a turn runs in a session the app marked a build's, so its rules are an app's. */
export const isAppRun = (sessionId) => Boolean(sessionId) && marked.has(String(sessionId))

export async function handleApps(req, res, path, { json, readBody }) {
  if (!path.startsWith("/api/plugins/gots/apps")) return false
  seed()
  const fail = (status, message) => json(res, status, { error: { message } })
  const found = (id) => apps.get(id)

  if (path === "/api/plugins/gots/apps") {
    if (req.method === "GET") {
      const listed = [...apps.values()].filter((one) => !one.hidden).sort(newestFirst)
      json(res, 200, { object: "gots.apps", apps: listed.map(summary) })
      return true
    }
    const body = await readBody(req)
    const title = typeof body.title === "string" ? body.title.trim() : ""
    if (!title) return fail(400, "An app needs a title."), true
    if (title.length > TITLE_MAX_CHARS)
      return (
        fail(
          413,
          `An app's title is capped at ${TITLE_MAX_CHARS} characters (the title cap); this one is ${title.length}.`,
        ),
        true
      )
    const sources = body.pages ?? (body.source === undefined ? [] : [body.source])
    if (!Array.isArray(sources) || !sources.length)
      return fail(400, "An app needs a page."), true
    const pages = []
    for (const one of sources) {
      const kept = checked(one)
      if (kept.error) return fail(...kept.error), true
      pages.push({ id: idOf(kept.source), source: kept.source, previous: null })
    }
    if (new Set(pages.map((page) => page.id)).size !== pages.length)
      return fail(400, "Two pages of an app can't share an id."), true
    const made = {
      id: `app-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      title,
      library_version:
        typeof body.library_version === "string" && body.library_version
          ? body.library_version
          : LIBRARY_VERSION,
      builtin: null,
      hidden: false,
      created_at: Date.now(),
      // Agreed at save, as `apps.create` agrees to what the pages it was handed name.
      consent: toolsOf(pages.map((page) => page.source)),
      pages,
    }
    apps.set(made.id, made)
    return json(res, 201, { object: "gots.app", app: summary(made) }), true
  }

  // A run marked an app's is given the app's rules rather than a chat's (openui.py, ADR 0101). The
  // mark is kept, and `isAppRun` is what mock-hermes.mjs answers a turn by: an app's reply without
  // the app having marked its run is a reply nothing asked for.
  if (path === "/api/plugins/gots/apps/builds") {
    const { session_id: session } = await readBody(req)
    if (typeof session !== "string" || !session)
      return fail(400, "A build needs a session id."), true
    marked.add(session)
    return json(res, 201, { object: "gots.app.build", marked: true }), true
  }

  // A page's query or mutation, answered by the host on the app's behalf: a tool the app was never
  // agreed to is refused (403), and one whose server can't be reached leaves the page its defaults.
  if (path === "/api/plugins/gots/apps/query") {
    const { app: id, shape, write } = await readBody(req)
    const one = found(String(id ?? ""))
    if (!one) return fail(404, "No such app."), true
    if (HOST_SHAPES.has(String(shape)))
      return fail(501, `The host's own reads aren't modelled by this mock (${shape}).`), true
    if (!(write ? one.consent.acts : one.consent.reads).includes(String(shape)))
      return fail(403, `This app was never agreed to call ${shape}.`), true
    return fail(502, `${shape} isn't answering from this host.`), true
  }

  const pageRoute = /^\/api\/plugins\/gots\/apps\/([^/]+)\/pages\/([^/]+)(\/undo)?$/.exec(path)
  if (pageRoute) {
    const one = found(decodeURIComponent(pageRoute[1]))
    if (!one) return fail(404, "No such app."), true
    const page = one.pages.find((each) => each.id === decodeURIComponent(pageRoute[2]))
    if (!page) return fail(404, "No such page."), true
    // Read after any write below, so an undo answers the source it put back.
    const shape = () => json(res, 200, { object: "gots.app.page", page: answer(one, page) })
    if (pageRoute[3]) {
      if (page.previous === null) return fail(409, "Nothing to undo."), true
      page.source = page.previous
      page.previous = null
      return shape(), true
    }
    if (req.method === "GET") return shape(), true
    const kept = checked((await readBody(req)).source)
    if (kept.error) return fail(...kept.error), true
    page.previous = page.source
    page.source = kept.source
    return shape(), true
  }

  const appRoute = /^\/api\/plugins\/gots\/apps\/([^/]+)\/(hidden|consent)$/.exec(path)
  if (appRoute) {
    const one = found(decodeURIComponent(appRoute[1]))
    if (!one) return fail(404, "No such app."), true
    const body = await readBody(req)
    if (appRoute[2] === "hidden") {
      if (typeof body.hidden !== "boolean") return fail(400, "hidden must be true or false."), true
      if (!one.builtin) return fail(409, "Only a built-in app is hidden; delete this one."), true
      one.hidden = body.hidden
      return (
        json(res, 200, { object: "gots.app", app: { id: one.id, hidden: one.hidden } }), true
      )
    }
    if (
      !body ||
      typeof body !== "object" ||
      !["reads", "acts"].every(
        (group) =>
          Array.isArray(body[group]) && body[group].every((name) => typeof name === "string"),
      )
    )
      return fail(400, "Agree to a list of reads and acts."), true
    // The list a person was shown, exactly: a page changed since can't ride in on an older answer.
    const shown = difference(named(one), one.consent)
    const posted = { reads: [...new Set(body.reads)].sort(), acts: [...new Set(body.acts)].sort() }
    if (posted.reads.join() !== shown.reads.join() || posted.acts.join() !== shown.acts.join())
      return fail(409, "The pages name other tools now; read the list again."), true
    one.consent = named(one)
    return (
      json(res, 200, {
        object: "gots.app",
        app: { id: one.id, tools: one.consent, pending: NONE },
      }),
      true
    )
  }

  return false
}
