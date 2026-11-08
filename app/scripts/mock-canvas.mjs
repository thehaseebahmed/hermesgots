// The Gots plugin's canvases (canvases.py), for the mock Hermes server. MOCK_CANVAS=0 serves a
// plugin from before them — no routes, no `canvas` feature.

const KEEP = 20

/** What the mock's bot writes: a page in the app's own theme tokens, as a canvas's guide asks. */
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
      <button onclick="document.getElementById('value').textContent = String(Number(document.getElementById('value').textContent) + 1)">Add one</button>
    </div>
  </body>
</html>`
}

export function createCanvasStore() {
  const canvases = new Map()

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

  const full = (c) => {
    const newest = c.versions[c.versions.length - 1]
    return {
      ...summary(c),
      html: newest?.html ?? "",
      tools: newest?.tools ?? [],
      written_at: newest?.at ?? c.at,
    }
  }

  return { canvases, summary, full }
}

export async function handleCanvas(req, res, path, { json, readBody, noteEvent }, store) {
  if (!path.startsWith("/api/plugins/gots/canvases")) return false
  const { canvases, summary, full } = store
  const fail = (status, message) => json(res, status, { error: { message } })

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
