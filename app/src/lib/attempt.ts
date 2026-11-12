import type { Attempted } from "@/lib/refusal"

/**
 * Runs a write, answering with how it ended rather than announcing it.
 *
 * `said` is the host's own words where it sent a non-blank sentence, and `alone` the sentence this
 * call would have said by itself — built from `what`, so no caller writes its failure sentence
 * twice. What a caller does with the answer is `refuse`'s to decide: the host's words held where the
 * write was made, or the app's own said in passing. The seam reaches no toast at all, which is what
 * makes drawing a failure in its surface the only way a caller can report one.
 */
export async function attempt(what: string, action: () => Promise<unknown>): Promise<Attempted> {
  try {
    await action()
    return { ok: true }
  } catch (error) {
    const said = error instanceof Error ? error.message.trim() : ""
    const alone = `Couldn't ${what}.`
    return said ? { ok: false, said, alone } : { ok: false, alone }
  }
}
