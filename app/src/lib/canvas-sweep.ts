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
 * removed. What it did read stays, which is what makes an interrupted sweep better than none — and
 * where it read to is kept on the sweep's mark, so the next sweep carries on from that page instead of
 * starting the canvas again.
 *
 * A host from before the paged route answers 404 to the catalogue: today's one whole read of the
 * canvas carries its documents, and what it answers is written as a completed sweep — an updated app
 * on an old host behaves exactly as it did before the rows. Only the catalogue is asked that way: a
 * page that answers 404 is the canvas moving under the sweep, never a route the host lacks.
 */

import { PAGE_ROWS, storedDocs } from "@/lib/canvas-bridge"
import {
  beginSweep,
  completeSweep,
  docKeys,
  keepDocs,
  noteSweepPlace,
  sweepCursor,
} from "@/lib/canvas-docs"
import type { Profile } from "@/lib/db"
import { dataCatalogue, dataPage, getCanvas, HermesError } from "@/lib/hermes"

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
  // Every key this sweep saw: what its completion prunes against, so a row it read and did not rewrite
  // is still a document the sweep saw.
  const swept = new Set<string>()
  // Only the catalogue is asked with the whole read in hand: a host from before the paged route has
  // no `/data` at all, and today's one read of the canvas stands in for a sweep that couldn't begin.
  // A 404 to a page of a canvas the host did catalogue is that canvas moving under the sweep, and it
  // leaves the pages that landed and prunes nothing rather than answering as a whole read.
  const catalogue = await catalogueOf(profile, id)
  if (!catalogue) {
    await sweepWhole(profile, id, generation, swept)
    return
  }
  // A sweep that was cut left the place it had reached: this one carries on from there, so a canvas of
  // five thousand is finished by the ticks a phone gives it rather than begun again at page one each
  // time. A place naming a collection the catalogue no longer holds is no place at all — the walk
  // starts over, and the generation it keeps is what leaves the rows it already read unpruned.
  const place = await sweepCursor(profile, id)
  const from = place
    ? catalogue.collections.findIndex((row) => row.collection === place.collection)
    : -1
  for (const [at, row] of catalogue.collections.entries()) {
    if (from >= 0 && at < from) continue
    await sweepCollection(
      profile,
      id,
      row.collection,
      generation,
      swept,
      from >= 0 && at === from && place ? place.after : null,
    )
  }
  const newest = catalogue.collections.reduce((at, one) => Math.max(at, one.newest_at ?? 0), 0)
  await completeSweep(profile, id, generation, newest, swept)
}

/**
 * The host's catalogue of the canvas's data, or null for a host that has no such route: a plugin from
 * before the paged read answers 404 to it, and nothing else is a route it lacks.
 */
async function catalogueOf(profile: Profile, id: string) {
  try {
    return await dataCatalogue(profile, id)
  } catch (failure) {
    if (failure instanceof HermesError && failure.status === 404) return null
    throw failure
  }
}

/** One collection, a page at a time, from `after` until the page that names no next. */
async function sweepCollection(
  profile: Profile,
  id: string,
  collection: string,
  generation: number,
  swept: Set<string>,
  after: string | null,
) {
  for (;;) {
    const page = await dataPage(profile, id, collection, after, PAGE_ROWS)
    // Every document the page named is one this sweep saw — including the ones `storedDocs` drops as
    // unreadable, since a row this device holds for one is not a document the host stopped naming.
    for (const key of await keepDocs(profile, id, storedDocs(page.documents), generation))
      swept.add(key)
    for (const key of docKeys(profile, id, page.documents)) swept.add(key)
    // The walk's place, written as each page lands: the next page's start is the last id this one
    // finished on, so a sweep cut here resumes with the page it did not read.
    const last = page.next ?? lastId(page.documents)
    if (last) await noteSweepPlace(profile, id, collection, last)
    if (page.next === null) return
    after = page.next
  }
}

/** The last id a page named, or null for a page that named no document at all. */
function lastId(documents: unknown[]): string | null {
  for (let at = documents.length - 1; at >= 0; at -= 1) {
    const one = documents[at] as { id?: unknown } | null
    if (one && typeof one === "object" && typeof one.id === "string" && one.id) return one.id
  }
  return null
}

/** The whole read a host without the paged route answers, kept as a completed sweep. */
async function sweepWhole(
  profile: Profile,
  id: string,
  generation: number,
  swept: Set<string>,
) {
  const raw = await getCanvas(profile, id, { docs: true })
  const docs = storedDocs(raw?.data)
  for (const key of await keepDocs(profile, id, docs, generation)) swept.add(key)
  await completeSweep(
    profile,
    id,
    generation,
    docs.reduce((at, one) => Math.max(at, one.at), 0),
    swept,
  )
}
