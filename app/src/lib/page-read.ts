/**
 * A page's text, read from where the app can reach it: a URL the host signed for an HTML file, or a
 * blob URL of one the user has staged but not yet sent. The Previewer draws a page from its markup
 * (a sandboxed `srcdoc`, ADR 0114), so it needs the text rather than an address to point a frame at.
 *
 * It answers `ready` or `failed` with a note, never a throw, so the Previewer shows its Retry and the
 * platform hand-over the way a medium that fails to load does. Import-free: the caller hands it
 * the request to make, which is the network log's `ask` (ADR 0086), so a test hands it its own.
 */

/**
 * The most a page may weigh: the media route's cap for a file it hands over rather than streams
 * (`DOWNLOAD_MAX_BYTES` in `plugin/media.py`), which is what an `.html` is served under.
 */
export const PAGE_MAX_BYTES = 25 * 1024 * 1024

/** A read that hasn't answered by now is treated as lost, as every other read is (`READ_TIMEOUT_MS`). */
export const PAGE_READ_TIMEOUT_MS = 15_000

export type PageRead = { state: "ready"; html: string } | { state: "failed"; note: string }

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

const MB = 1024 * 1024

function tooLarge(limit: number): PageRead {
  return { state: "failed", note: `This page is larger than the ${Math.round(limit / MB)} MB limit.` }
}

/** The text of the page at `url`, or why it couldn't be read. */
export async function readPage(
  url: string,
  options: { fetch: Fetch; limit?: number; timeoutMs?: number; signal?: AbortSignal },
): Promise<PageRead> {
  const get = options.fetch
  const limit = options.limit ?? PAGE_MAX_BYTES
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PAGE_READ_TIMEOUT_MS)
  const stop = () => controller.abort()
  options.signal?.addEventListener("abort", stop)
  try {
    const response = await get(url, { signal: controller.signal })
    if (!response.ok) return { state: "failed", note: `The host answered ${response.status}.` }
    // A length said up front is refused before any bytes are read; one not said is checked after.
    const said = Number(response.headers.get("content-length"))
    if (Number.isFinite(said) && said > limit) return tooLarge(limit)
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > limit) return tooLarge(limit)
    return { state: "ready", html: new TextDecoder().decode(bytes) }
  } catch (error) {
    if (controller.signal.aborted) {
      return { state: "failed", note: options.signal?.aborted ? "The read was cancelled." : "The page took too long to load." }
    }
    return { state: "failed", note: error instanceof Error && error.message ? error.message : "The page couldn't be read." }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", stop)
  }
}
