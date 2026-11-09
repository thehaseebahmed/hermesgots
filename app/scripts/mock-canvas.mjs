// The Gots plugin's canvases (canvases.py), for the mock Hermes server. MOCK_CANVAS=0 serves a
// plugin from before them — no routes, no `canvas` feature.

import { randomUUID } from "node:crypto"

import { inOrder } from "../src/lib/canvas-bridge.ts"

const KEEP = 20
const DATA_BYTES = 1024 * 1024
const NAME_CHARS = 64
// The plugin's own cap (`plugin/canvases.py`) and its one-line rule: a title is cut here too.
const TITLE_CHARS = 60

function titleOf(text) {
  const flat = String(text).trim().split(/\s+/).join(" ")
  return flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS - 1)}…` : flat
}

const escapeHtml = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * What the mock's bot writes: a page in the app's own theme tokens, its count and box kept in the
 * canvas's own data through the page's bridge, and a Leave button that asks to go to an outside URL.
 */
function page(prompt, title, version, edited) {
  const promptText = escapeHtml(prompt)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body { margin: 0; padding: 24px; background: var(--background); color: var(--foreground);
             font-family: system-ui, sans-serif; }
      h1 { margin: 0 0 8px; font-size: 24px; letter-spacing: -0.02em; }
      p { margin: 0 0 16px; color: var(--muted-foreground); }
      .card { padding: 16px; border: 1px solid var(--border); border-radius: var(--radius);
              background: var(--card); }
      .card + .card { margin-top: 12px; }
      .value { font-size: 40px; font-weight: 600; color: var(--primary); font-variant-numeric: tabular-nums; }
      .row { display: flex; align-items: center; gap: 12px; }
      .row label { display: flex; min-height: 44px; flex: 1; align-items: center; gap: 10px; font-size: 16px; }
      .row input { width: 22px; height: 22px; accent-color: var(--primary); }
      button { min-height: 44px; padding: 0 20px; border: 0; border-radius: 999px;
               background: var(--primary); color: var(--primary-foreground); font-size: 16px; }
    </style>
  </head>
  <body>
    <h1>Deck checklist</h1>
    <p>${promptText}</p>
    <div class="card row">
      <label><input type="checkbox" id="done"> Done</label>
      <button id="leave">Leave</button>
    </div>
    <div class="card">
      <div class="value" id="value">0</div>
      <p>Version ${version} of this canvas, drawn from what its bot wrote.</p>
      ${edited ? `<p id="edited">${escapeHtml(edited)}</p>` : ""}
      <button id="add">Add one</button>
    </div>
    <div class="card">
      <p id="found">The host's files, not searched yet.</p>
      <button id="search">Search the files</button>
    </div>
    <script>
      (function () {
        var value = document.getElementById("value");
        var show = function (n) { value.textContent = String(n); };
        var store = window.canvas.data;
        // The count is the canvas's, not the page's: it opens at what the host kept, and each tap
        // is one write the app takes to the host.
        store.list("counter").then(function (rows) {
          for (var i = 0; i < rows.length; i += 1) {
            if (rows[i].id === "value" && rows[i].doc && typeof rows[i].doc.n === "number") {
              show(rows[i].doc.n);
            }
          }
        }).catch(function () {});
        document.getElementById("add").addEventListener("click", function () {
          var n = Number(value.textContent) + 1;
          show(n);
          // A write the host refused is the one case the bridge's error path exists for: without a
          // word here the page draws a number the host never kept.
          store.put("counter", "value", { n: n }).catch(function (error) {
            console.error("canvas data:", error);
          });
        });
        var box = document.getElementById("done");
        store.list("checks").then(function (rows) {
          for (var i = 0; i < rows.length; i += 1) {
            if (rows[i].id === "done" && rows[i].doc && rows[i].doc.done === true) {
              box.checked = true;
            }
          }
        }).catch(function (error) {
          console.error("canvas data:", error);
        });
        box.addEventListener("change", function () {
          store.put("checks", "done", { done: box.checked }).catch(function (error) {
            console.error("canvas data:", error);
          });
        });
        document.getElementById("leave").addEventListener("click", function () {
          location.href = "https://example.com/gone";
        });
        // The page's one declared tool: its first call is the reader's to answer, and the answer is
        // kept on the host, so the second search never asks again.
        var found = document.getElementById("found");
        document.getElementById("search").addEventListener("click", function () {
          window.canvas.tool.call("files.search", { q: "notes" }).then(function (answer) {
            var hits = answer && answer.hits ? answer.hits.length : 0;
            found.textContent = hits + " found for " + String((answer && answer.query) || "notes") + ".";
          }).catch(function (error) {
            found.textContent = String((error && error.message) || error);
          });
        });
      })();
    </script>
  </body>
</html>`
}

export function createCanvasStore() {
  const canvases = new Map()
  // The canvas a run's session edits, so a turn in a chat finds its canvas without walking them all.
  const bySession = new Map()

  /**
   * The greatest version stored under the record's pointer, as the plugin's `_greatest_below` reads:
   * the number itself, or null when nothing sits below the pointer.
   */
  const below = (c) => {
    const under = c.versions.filter((v) => v.version < c.version).map((v) => v.version)
    return under.length ? Math.max(...under) : null
  }

  // A listing carries the record and no document, so no `can_undo`: only the one-canvas answer does,
  // as the plugin's own `listing` answers — and no grants either, since the plugin's listing answers
  // a record alone. The answers ride the one-canvas answer, which is what a screen draws.
  const summary = (c) => ({
    id: c.id,
    title: c.title,
    session_id: c.session_id,
    chat_id: c.chat_id,
    version: c.version,
    pinned: c.pinned,
    archived: c.archived,
    image: c.image ?? null,
    at: c.at,
    created_at: c.created_at,
  })

  // The pointer's version, not the newest stored one: an undo moves the pointer back and leaves the
  // versions above it stored but unreachable, as the plugin does. The canvas's data rides the
  // answer, ordered as the host orders it.
  const full = (c) => {
    const current = c.versions.find((v) => v.version === c.version)
    const earlier = below(c)
    return {
      ...summary(c),
      html: current?.html ?? "",
      tools: current?.tools ?? [],
      // The reader's answers ride the one-canvas answer: a record the list carries has no room for
      // them, and the options read the canvas they change.
      grants: c.grants ?? [],
      written_at: current?.at ?? c.at,
      can_undo: earlier !== null,
      data: inOrder(c.docs),
    }
  }

  // The record alone, plus whether a version sits under the drawn one: what the plugin's update route
  // answers, so a client that renamed or pinned a canvas keeps the page it already draws.
  const record = (c) => ({ ...summary(c), can_undo: below(c) !== null })

  return { canvases, bySession, summary, record, full, below }
}

/**
 * The picture a canvas's tile draws, as the plugin keeps one: a single inline image, made here from
 * the canvas's own name and version, so a tile is visibly that canvas's rather than a shared mark.
 */
function picture(canvas) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240"><rect width="320" height="240" fill="#0d2b22"/><rect x="24" y="28" width="272" height="120" rx="12" fill="#123d2f"/><circle cx="72" cy="188" r="10" fill="#2f7d5f"/><text x="96" y="194" fill="#7ee2b8" font-family="ui-sans-serif, sans-serif" font-size="20">${escapeHtml(canvas.title).slice(0, 24)}</text></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
}

/**
 * Writes the canvas's next version, as `canvases.py`'s `_commit` does: the history above the record's
 * pointer goes first, so an undo leaves no redo and the pointer's version is the only row at its
 * number, then the page is built from what the version was asked to say. The canvas's data — the
 * box, the count — sits outside the versions, so a new one opens with what the reader left.
 */
function writeVersion(canvas, words) {
  canvas.version += 1
  canvas.at = Date.now()
  canvas.versions = canvas.versions.filter((one) => one.version < canvas.version)
  const edited = typeof words === "string" ? words.replace(/\s+/g, " ").trim().slice(0, 200) : ""
  canvas.image = picture(canvas)
  canvas.versions.push({
    version: canvas.version,
    html: page(canvas.prompt, canvas.title, canvas.version, edited),
    tools: canvas.tools,
  })
  if (canvas.versions.length > KEEP) canvas.versions.shift()
}

/**
 * The version a turn in a canvas's own chat writes: the mock's stand-in for the bot calling
 * `canvas_edit`, the tool a real canvas session is equipped with (`canvases.py`).
 */
export function editCanvasSession(store, sessionId, words) {
  const canvas = store.bySession.get(sessionId)
  if (!canvas) return null
  writeVersion(canvas, words)
  return canvas
}

export async function handleCanvas(
  req,
  res,
  path,
  { json, readBody, noteEvent, sessions, openChat },
  store,
) {
  if (!path.startsWith("/api/plugins/gots/canvases")) return false
  const { canvases, bySession, summary, full, below } = store
  const fail = (status, message, code) =>
    json(res, status, { error: { message, ...(code ? { code } : {}) } })
  /** Whether the version the pointer names declared ``tool``. */
  const declared = (canvas, tool) => {
    const current = canvas.versions.find((v) => v.version === canvas.version)
    return (current?.tools ?? []).includes(tool)
  }

  // A collection and a document id are names the page sends, as the plugin checks them: 1 to 64
  // characters, with no control character.
  const name = (value, what) => {
    if (typeof value !== "string" || !value || [...value].length > NAME_CHARS) {
      return { error: `A document's ${what} is a name of 1 to ${NAME_CHARS} characters.` }
    }
    for (const character of value) {
      const code = character.codePointAt(0)
      if (code < 32 || code === 127) {
        return { error: `A document's ${what} can't hold a control character.` }
      }
    }
    return { name: value }
  }

  // A page's own data: the canvas's store, written without consent, as the plugin's call route
  // answers it. The cap is the whole of a canvas's data and a write past it is refused whole.
  const call = /^\/api\/plugins\/gots\/canvases\/([^/]+)\/call$/.exec(path)
  if (call) {
    const canvas = canvases.get(decodeURIComponent(call[1]))
    if (!canvas) {
      fail(404, "There is no such canvas.")
      return true
    }
    if (req.method !== "POST") {
      fail(405, "A page's call is a POST.")
      return true
    }
    const body = (await readBody(req)) ?? {}
    const shape = body.shape
    const args = body.args && typeof body.args === "object" ? body.args : {}
    // The host's four free reads (ADR 0114): no declaration and no consent, answered from what the
    // mock holds, with a stub account and one routine so a page has something to draw.
    // Each read answers the shape the app's own screens draw: a provider's usage, a routine per job
    // as the host projects one, the projects, and this bot's chats newest first.
    const reads = {
      usage: () => ({
        provider: "anthropic",
        plan: "Pro",
        windows: [
          { label: "Session", used_percent: 12, resets_at: null, detail: null, scope: "account" },
        ],
      }),
      routines: () => ({
        routines: [
          {
            id: "r_morning",
            name: "Morning brief",
            enabled: true,
            schedule_display: "Every day at 8",
          },
        ],
      }),
      projects: () => ({ projects: [] }),
      sessions: () => ({ sessions: (sessions ? sessions() : []).slice(0, 50) }),
    }
    const read =
      typeof shape === "string" && Object.hasOwn(reads, shape) ? reads[shape] : undefined
    if (read) {
      json(res, 200, { object: "gots.canvas.call", result: read() })
      return true
    }
    // A declared tool: refused undeclared, then asked about, then refused or called as the reader
    // answered. The codes match the plugin's, so the app's consent hold is exercised by the mock.
    if (typeof shape === "string" && shape.includes(".") && !shape.startsWith("data.")) {
      const tool = shape
      if (!declared(canvas, tool)) {
        fail(403, `This canvas never declared ${tool}.`, "not_declared")
        return true
      }
      const answer = (canvas.grants ?? []).find((row) => row.tool === tool)
      if (!answer) {
        fail(
          403,
          `This canvas's page was never allowed to call ${tool}: its first call is the user's to answer.`,
          "consent_required",
        )
        return true
      }
      if (!answer.allowed) {
        fail(403, `The user did not allow this canvas's page to call ${tool}.`, "denied")
        return true
      }
      json(res, 200, {
        object: "gots.canvas.call",
        result: { tool, query: typeof args.q === "string" ? args.q : null, hits: [] },
      })
      return true
    }
    if (shape !== "data.put" && shape !== "data.remove") {
      fail(501, `This host cannot call ${JSON.stringify(shape)} for a canvas.`)
      return true
    }
    const collection = name(args.collection, "collection")
    if (collection.error) {
      fail(400, collection.error)
      return true
    }
    const id = name(args.id, "id")
    if (id.error) {
      fail(400, id.error)
      return true
    }
    if (shape === "data.remove") {
      const removed = canvas.docs.some(
        (row) => row.collection === collection.name && row.id === id.name,
      )
      canvas.docs = canvas.docs.filter(
        (row) => row.collection !== collection.name || row.id !== id.name,
      )
      json(res, 200, {
        object: "gots.canvas.call",
        result: { collection: collection.name, id: id.name, removed },
      })
      return true
    }
    // A stored null is a value, so whether a document was sent decides rather than what it holds.
    const doc = "doc" in args ? args.doc : null
    const value = JSON.stringify(doc)
    if (value === undefined) {
      fail(
        400,
        "A document has to be JSON: a canvas's data is stored as JSON, so every value in a " +
          "document has to be one.",
      )
      return true
    }
    let size = Buffer.byteLength(value, "utf8")
    for (const row of canvas.docs) {
      if (row.collection === collection.name && row.id === id.name) continue
      size += Buffer.byteLength(row.collection, "utf8") + Buffer.byteLength(row.id, "utf8")
      size += Buffer.byteLength(JSON.stringify(row.doc), "utf8")
    }
    size += Buffer.byteLength(collection.name, "utf8") + Buffer.byteLength(id.name, "utf8")
    if (size > DATA_BYTES) {
      fail(
        400,
        `A canvas's data is capped at 1 MB; this write would make it ${Math.ceil(size / 1024)} KB. Remove something first.`,
      )
      return true
    }
    const result = {
      collection: collection.name,
      id: id.name,
      doc: JSON.parse(value),
      at: Date.now(),
    }
    canvas.docs = [
      ...canvas.docs.filter((row) => row.collection !== collection.name || row.id !== id.name),
      result,
    ]
    json(res, 200, { object: "gots.canvas.call", result })
    return true
  }

  // The reader's answer about a declared tool, kept on the canvas for every device, as the plugin's
  // own grants route does. The answer is the canvas as it now is, so the options redraw at once.
  const grants = /^\/api\/plugins\/gots\/canvases\/([^/]+)\/grants$/.exec(path)
  if (grants) {
    const canvas = canvases.get(decodeURIComponent(grants[1]))
    if (!canvas) {
      fail(404, "There is no such canvas.")
      return true
    }
    if (req.method !== "POST") {
      fail(405, "A grant is a POST.")
      return true
    }
    const body = (await readBody(req)) ?? {}
    if (typeof body.tool !== "string" || !body.tool) {
      fail(400, "A grant names the tool it answers for.")
      return true
    }
    if (!declared(canvas, body.tool) && !(canvas.grants ?? []).some((row) => row.tool === body.tool)) {
      fail(403, `This canvas never declared ${body.tool}.`, "not_declared")
      return true
    }
    const granted = { tool: body.tool, allowed: Boolean(body.allow), at: Date.now() }
    canvas.grants = [
      ...(canvas.grants ?? []).filter((row) => row.tool !== body.tool),
      granted,
    ].sort((one, two) => (one.tool < two.tool ? -1 : 1))
    json(res, 200, { object: "gots.canvas.grant", grant: granted, grants: canvas.grants })
    return true
  }

  if (path === "/api/plugins/gots/canvases") {
    if (req.method === "GET") {
      const list = [...canvases.values()].sort((a, b) => b.at - a.at).map(summary)
      json(res, 200, { object: "gots.canvases", canvases: list })
      return true
    }
    const body = await readBody(req)
    {
      const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : ""
      if (!prompt) return fail(400, "A canvas needs a prompt to build it from."), true
      const now = Date.now()
      const title = titleOf(prompt)
      // The chat the canvas is edited in is the one `triage.open_thread` makes: an app-kind id, a
      // session named for it, the canvas's own name marked `titleEdited`, and `canvasId` so no list
      // or card ever draws it (canvases.py's `create`).
      const chatId = randomUUID()
      const canvas = {
        id: `c_${randomUUID().slice(0, 8)}`,
        title,
        session_id: `gots-${chatId}`,
        chat_id: chatId,
        version: 0,
        pinned: false,
        archived: false,
        // Nothing until a version is written: a canvas still being built draws its own mark.
        image: null,
        at: now,
        created_at: now,
        versions: [],
        docs: [],
        // One declared tool, so the canvas's options have a row and a page that calls it (from a
        // devtools console, or a canvas someone edits) meets the consent dialog.
        tools: ["files.search"],
        grants: [],
        prompt,
      }
      canvases.set(canvas.id, canvas)
      bySession.set(canvas.session_id, canvas)
      openChat?.({
        chatId,
        sessionId: canvas.session_id,
        profileId: body?.profile_id ?? null,
        title,
        canvasId: canvas.id,
        opener: prompt,
        at: now,
      })
      // The gap is what lets the screen draw version 0 — "your bot is building it" — before the
      // page lands, with room for a phone to raise its sheet in the meantime.
      setTimeout(() => {
        writeVersion(canvas)
        noteEvent("canvas", canvas.session_id)
      }, 2500)
      json(res, 202, { object: "gots.canvas", canvas: full(canvas) })
      return true
    }
  }

  const undo = /^\/api\/plugins\/gots\/canvases\/([^/]+)\/undo$/.exec(path)
  if (undo) {
    const canvas = canvases.get(decodeURIComponent(undo[1]))
    if (!canvas) {
      fail(404, "There is no such canvas.")
      return true
    }
    if (req.method !== "POST") {
      fail(405, "Undo is a POST.")
      return true
    }
    const earlier = below(canvas)
    if (earlier === null) {
      fail(409, "This canvas has no earlier version to undo to.")
      return true
    }
    canvas.version = earlier
    canvas.at = Date.now()
    noteEvent("canvas", canvas.session_id)
    json(res, 200, { object: "gots.canvas", canvas: full(canvas) })
    return true
  }

  const match = /^\/api\/plugins\/gots\/canvases\/([^/]+)$/.exec(path)
  if (!match) return false
  const canvas = canvases.get(decodeURIComponent(match[1]))
  if (!canvas) {
    fail(404, "There is no such canvas.")
    return true
  }

  if (req.method === "POST") {
    const body = (await readBody(req)) ?? {}
    if (!["title", "pinned", "archived", "image"].some((field) => field in body)) {
      fail(400, "A canvas's update names what changes: a title, pinned, archived, or image.")
      return true
    }
    if ("title" in body) {
      if (typeof body.title !== "string" || !body.title.trim()) {
        fail(400, "A canvas's title is a line of text; this one is blank.")
        return true
      }
      const title = body.title.trim()
      canvas.title = titleOf(title)
    }
    for (const field of ["pinned", "archived"]) {
      if (!(field in body)) continue
      if (typeof body[field] !== "boolean") {
        fail(400, `A canvas's ${field} is true or false; this one is ${JSON.stringify(body[field])}.`)
        return true
      }
      canvas[field] = body[field]
    }
    if ("image" in body) {
      if (typeof body.image !== "string" || (body.image && !body.image.startsWith("data:image/"))) {
        fail(400, "A canvas's image is an inline picture, as a data URL.")
        return true
      }
      canvas.image = body.image || null
    }
    canvas.at = Date.now()
    noteEvent("canvas", canvas.session_id)
    json(res, 200, { object: "gots.canvas", canvas: store.record(canvas) })
    return true
  }

  if (req.method === "DELETE") {
    canvases.delete(canvas.id)
    bySession.delete(canvas.session_id)
    noteEvent("canvas", canvas.session_id)
    json(res, 200, { object: "gots.canvas.deleted", deleted: true, id: canvas.id })
    return true
  }

  if (req.method !== "GET") {
    fail(405, "A canvas is read with a GET, changed with a POST and removed with a DELETE.")
    return true
  }
  json(res, 200, { object: "gots.canvas", canvas: full(canvas) })
  return true
}
