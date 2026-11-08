// The Gots plugin's canvases (canvases.py), for the mock Hermes server. MOCK_CANVAS=0 serves a
// plugin from before them — no routes, no `canvas` feature.

import { inOrder } from "../src/lib/canvas-bridge.ts"

const KEEP = 20
const DATA_BYTES = 1024 * 1024
const NAME_CHARS = 64

/**
 * What the mock's bot writes: a page in the app's own theme tokens, as a canvas's guide asks. Its
 * count is the canvas's own data, kept through the page's bridge the way a real canvas keeps state.
 */
function page(prompt, title, version) {
  const escaped = String(prompt)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
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
      .value { font-size: 40px; font-weight: 600; color: var(--primary); font-variant-numeric: tabular-nums; }
      button { min-height: 44px; padding: 0 20px; border: 0; border-radius: 999px;
               background: var(--primary); color: var(--primary-foreground); font-size: 16px; }
    </style>
  </head>
  <body>
    <h1>${title}</h1>
    <p>${escaped}</p>
    <div class="card">
      <div class="value" id="value">0</div>
      <p>Version ${version} of this canvas, drawn from what its bot wrote.</p>
      <button id="add">Add one</button>
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
      })();
    </script>
  </body>
</html>`
}

export function createCanvasStore() {
  const canvases = new Map()

  /**
   * The greatest version stored under the record's pointer, as the plugin's `_greatest_below` reads:
   * the number itself, or null when nothing sits below the pointer.
   */
  const below = (c) => {
    const under = c.versions.filter((v) => v.version < c.version).map((v) => v.version)
    return under.length ? Math.max(...under) : null
  }

  // A listing carries the record and no document, so no `can_undo`: only the one-canvas answer does,
  // as the plugin's own `listing` answers.
  const summary = (c) => ({
    id: c.id,
    title: c.title,
    session_id: c.session_id,
    chat_id: c.chat_id,
    version: c.version,
    pinned: c.pinned,
    hidden: c.hidden,
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
      written_at: current?.at ?? c.at,
      can_undo: earlier !== null,
      data: inOrder(c.docs),
    }
  }

  return { canvases, summary, full, below }
}

export async function handleCanvas(req, res, path, { json, readBody, noteEvent }, store) {
  if (!path.startsWith("/api/plugins/gots/canvases")) return false
  const { canvases, summary, full, below } = store
  const fail = (status, message) => json(res, status, { error: { message } })

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
      const title = prompt.length > 60 ? `${prompt.slice(0, 59)}…` : prompt
      const canvas = {
        id: `c_${Math.random().toString(16).slice(2, 18)}`,
        title,
        session_id: `gots-${Math.random().toString(16).slice(2, 18)}`,
        chat_id: Math.random().toString(16).slice(2, 18),
        version: 0,
        pinned: false,
        hidden: false,
        at: now,
        created_at: now,
        versions: [],
        docs: [],
        prompt,
      }
      canvases.set(canvas.id, canvas)
      // The gap is what lets the screen draw version 0 — "your bot is building it" — before the
      // page lands.
      setTimeout(() => {
        canvas.version += 1
        canvas.at = Date.now()
        canvas.versions.push({ version: canvas.version, html: page(prompt, title, canvas.version), tools: [] })
        if (canvas.versions.length > KEEP) canvas.versions.shift()
        noteEvent("canvas", canvas.session_id)
      }, 1500)
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
  json(res, 200, { object: "gots.canvas", canvas: full(canvas) })
  return true
}
