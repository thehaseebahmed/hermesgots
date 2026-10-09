// Imported by the generated service worker (vite.config.ts). The installed PWA's share target
// (the manifest's share_target) posts what was shared here; it's kept in a cache for the share
// screen to read, which a redirect then opens.

const SHARE_CACHE = "memento-share"

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== "POST" || url.origin !== self.location.origin) return
  if (url.pathname !== "/share-target") return
  event.respondWith(receive(event.request))
})

async function receive(request) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  try {
    const form = await request.formData()
    // Only the latest share is ever read.
    await caches.delete(SHARE_CACHE)
    const cache = await caches.open(SHARE_CACHE)
    const files = form.getAll("media").filter((file) => typeof file !== "string" && file.size)
    const meta = {
      title: String(form.get("title") || ""),
      text: String(form.get("text") || ""),
      url: String(form.get("url") || ""),
      files: [],
    }
    for (const [index, file] of files.slice(0, 10).entries()) {
      const key = `/__share/${id}/${index}`
      await cache.put(key, new Response(file, { headers: { "content-type": file.type } }))
      meta.files.push({ key, name: file.name, type: file.type })
    }
    await cache.put(`/__share/${id}`, Response.json(meta))
  } catch {
    // The share screen says there was nothing to share.
  }
  return Response.redirect(`/share?id=${id}`, 303)
}
