import { failed, type Attempted } from "./refusal.ts"

/**
 * Runs a write, answering with how it ended rather than announcing it.
 *
 * `failed` (lib/refusal.ts) words the answer: the host's own words where it sent a sentence, and the
 * app's own — built from `what`, so no caller writes its failure sentence twice — where it didn't.
 * What a caller does with the answer is `refuse`'s to decide: the host's words held where the write
 * was made, or the app's own said in passing. The seam reaches no toast at all, which is what makes
 * drawing a failure in its surface the only way a caller can report one.
 */
export async function attempt(what: string, action: () => Promise<unknown>): Promise<Attempted> {
  try {
    await action()
    return { ok: true }
  } catch (error) {
    return failed(error, `Couldn't ${what}.`)
  }
}
