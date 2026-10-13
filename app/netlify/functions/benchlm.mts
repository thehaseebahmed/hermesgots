import { getStore } from "@netlify/blobs"

const BENCHLM_URL = "https://data.benchlm.ai/v1/rankings/current?surface=coding"
const CACHE_KEY = "coding"
// 4 hours: BenchLM's free plan is 1,000 reads/month, so a single shared fetch every 4
// hours stays well under the limit regardless of how many devices open the picker.
const MAX_AGE_MS = 4 * 60 * 60 * 1000
// The API caps at 100 items per request; the coding surface has ~147, so two pages get all.
const PAGE_SIZE = 100

interface CachedRankings {
  data: unknown
  fetchedAt: number
}

interface RankingsPayload {
  items?: unknown[]
}

/** Fetches all pages of the coding rankings, merging the items into one payload. */
async function fetchAllRankings(key: string): Promise<unknown> {
  const headers = { Authorization: `Bearer ${key}` }
  const first = await fetch(`${BENCHLM_URL}&limit=${PAGE_SIZE}`, { headers })
  if (!first.ok) throw new Error(`BenchLM responded ${first.status}`)
  const data: RankingsPayload = await first.json()
  if (!Array.isArray(data.items)) throw new Error("BenchLM returned an unexpected payload")
  // If the first page is full, fetch the rest.
  if (data.items.length === PAGE_SIZE) {
    const second = await fetch(`${BENCHLM_URL}&limit=${PAGE_SIZE}&offset=${PAGE_SIZE}`, { headers })
    if (second.ok) {
      const more: RankingsPayload = await second.json()
      if (Array.isArray(more.items)) data.items = [...data.items, ...more.items]
    }
  }
  return data
}

export default async (_req: Request) => {
  const key = process.env.BENCHLM_DATA_KEY
  if (!key) return Response.json({ error: "BENCHLM_DATA_KEY is not set" }, { status: 502 })

  const store = getStore({ name: "memento-rankings", consistency: "strong" })
  const cached = (await store.get(CACHE_KEY, { type: "json" })) as CachedRankings | null

  // Serve fresh cache without hitting upstream.
  if (cached && Date.now() - cached.fetchedAt < MAX_AGE_MS)
    return json(cached.data, cached.fetchedAt, true)

  // Refetch; a failure serves stale data if we have it, so the picker keeps working.
  try {
    const data = await fetchAllRankings(key)
    const entry: CachedRankings = { data, fetchedAt: Date.now() }
    await store.setJSON(CACHE_KEY, entry)
    return json(data, entry.fetchedAt, false)
  } catch {
    if (cached) return json(cached.data, cached.fetchedAt, true)
    return Response.json({ error: "BenchLM is unreachable" }, { status: 502 })
  }
}

function json(data: unknown, fetchedAt: number, cached: boolean) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=14400",
      "Access-Control-Allow-Origin": "*",
      "X-Cached": cached ? "1" : "0",
      "X-Fetched-At": String(fetchedAt),
    },
  })
}