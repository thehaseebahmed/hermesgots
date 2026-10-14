/**
 * An opaque per-user document store for sync. Clients encrypt every document before it leaves the
 * browser, so this only checks names, sizes and versions; it never sees a plaintext field.
 */

export interface DocStore {
  getWithMetadata(
    key: string,
    options: { type: "json" },
  ): Promise<{ data: unknown; etag?: string } | null>
  setJSON(
    key: string,
    data: unknown,
    options: { onlyIfMatch: string } | { onlyIfNew: boolean },
  ): Promise<{ modified: boolean; etag?: string }>
  delete(key: string): Promise<void>
}

const DOC = /^(vault|bots|settings|chats\/[A-Za-z0-9_-]{1,64})$/
const USER = /^[A-Za-z0-9_-]{1,128}$/
const MAX_BYTES = 1024 * 1024

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

function error(message: string, status: number) {
  return json({ error: message }, status)
}

export async function handleDocs(req: Request, userId: string, store: DocStore) {
  const doc = new URL(req.url).searchParams.get("doc") ?? ""
  if (!DOC.test(doc)) return error("Unknown document", 400)
  if (!USER.test(userId)) return error("Unsupported user id", 400)
  const key = `${userId}/${doc}`

  if (req.method === "GET") {
    const entry = await store.getWithMetadata(key, { type: "json" })
    if (!entry) return error("Not found", 404)
    return json({ etag: entry.etag, data: entry.data })
  }

  if (req.method === "PUT") {
    const raw = await req.text()
    if (raw.length > MAX_BYTES) return error("Document too large", 413)
    let body: { data?: unknown; etag?: unknown }
    try {
      body = JSON.parse(raw)
    } catch {
      return error("Invalid JSON", 400)
    }
    const { data, etag } = body ?? {}
    if (!data || typeof data !== "object" || Array.isArray(data)) return error("Invalid data", 400)
    if (etag !== undefined && typeof etag !== "string") return error("Invalid etag", 400)
    // A write must name the version it read, so two devices can't overwrite each other blindly.
    const result = await store.setJSON(
      key,
      data,
      etag ? { onlyIfMatch: etag } : { onlyIfNew: true },
    )
    if (!result.modified) return error("Changed since it was read", 412)
    return json({ etag: result.etag })
  }

  if (req.method === "DELETE") {
    await store.delete(key)
    return new Response(null, { status: 204 })
  }

  return error("Method not allowed", 405)
}
