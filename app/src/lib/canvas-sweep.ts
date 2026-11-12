/**
 * A sweep: one device reading a canvas's documents to fill its own copy (GLOSSARY, "Sweep").
 *
 * The host catalogues the canvas by collection — one row a collection, no document — and then answers
 * one collection a page at a time, each page naming the id the next starts after. Every page lands in
 * `canvas-docs.ts` as it arrives, under the generation this sweep began, so a canvas of five thousand
 * documents is twenty-five reads rather than one answer and a page lists what has landed so far.
 *
 * A sweep is *completed* only once the last page of the last collection has landed, and only a
 * completed sweep prunes (`completeSweep`): a page is no evidence a document is gone, because the
 * host's remove writes no tombstone, so a sweep that was cut may not treat what it did not read as
 * removed. What it did read stays, which is what makes an interrupted sweep better than none.
 *
 * A host from before the paged route answers 404 to the catalogue: today's one whole read of the
 * canvas carries its documents, and what it answers is written as a completed sweep — an updated app
 * on an old host behaves exactly as it did before the rows.
 */

import { storedDoc, type CanvasDoc } from "@/lib/canvas-bridge"
import { beginSweep, completeSweep, keepDocs } from "@/lib/canvas-docs"
import type { Profile } from "@/lib/db"
import { dataCatalogue, dataPage, getCanvas, HermesError } from "@/lib/hermes"

/** How many documents one page of a sweep asks for: the page the host answers without being told. */
export const SWEEP_PAGE = 200

// One sweep of one canvas at a time: a screen opening a canvas and the list's poll asking for the same
// one is one read of the host, and the second joins the first rather than racing it into the rows.
const sweeping = new Map<string, Promise<void>>()

/** Fills this device's rows for one canvas. A sweep already under way for it is joined. */
export function sweepCanvas(profile: Profile, id: string): Promise<void> {
  const running = sweeping.get(id)
  if (running) return running
  const sweep = run(profile, id).finally(() => {
    if (sweeping.get(id) === sweep) sweeping.delete(id)
  })
  sweeping.set(id, sweep)
  return sweep
}

async function run(profile: Profile, id: string) {
  const generation = await beginSweep(profile, id)
  try {
    const catalogue = await dataCatalogue(profile, id)
    for (const { collection } of catalogue.collections)
      await sweepCollection(profile, id, collection, generation)
    const newest = catalogue.collections.reduce((at, one) => Math.max(at, one.newest_at ?? 0), 0)
    await completeSweep(profile, id, generation, newest)
  } catch (failure) {
    // A plugin from before this route has no catalogue to answer: the canvas itself carries its
    // documents, and they are kept as one completed sweep. Any other failure leaves the rows this
    // sweep wrote and nothing pruned, since a sweep that didn't finish has seen no more than the last.
    if (!(failure instanceof HermesError && failure.status === 404)) throw failure
    await sweepWhole(profile, id, generation)
  }
}

/** One collection, a page at a time, until the page that names no next. */
async function sweepCollection(
  profile: Profile,
  id: string,
  collection: string,
  generation: number,
) {
  let after: string | null = null
  for (;;) {
    const page = await dataPage(profile, id, collection, after, SWEEP_PAGE)
    const docs = page.documents.map(storedDoc).filter((one): one is CanvasDoc => one !== null)
    await keepDocs(profile, id, docs, generation)
    if (page.next === null) return
    after = page.next
  }
}

/** The whole read a host without the paged route answers, kept as a completed sweep. */
async function sweepWhole(profile: Profile, id: string, generation: number) {
  const raw = await getCanvas(profile, id, { docs: true })
  const docs = Array.isArray(raw?.data)
    ? raw.data.map(storedDoc).filter((one): one is CanvasDoc => one !== null)
    : []
  await keepDocs(profile, id, docs, generation)
  await completeSweep(
    profile,
    id,
    generation,
    docs.reduce((at, one) => Math.max(at, one.at), 0),
  )
}
