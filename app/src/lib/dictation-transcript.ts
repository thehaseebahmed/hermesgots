/**
 * What a take has heard, as the voice bar shows it: the phrases it has finished and the words it
 * has committed since the last one, in the order they were said.
 *
 * A take's answers carry only what is new — the words committed since the last answer, the phrases
 * just closed — so this is the fold that holds a whole take, and the only thing that decides what
 * the take's text is. Import-free, so `scripts/test-dictation-transcript.mjs` runs it as a pure
 * rule.
 */

export interface DictationPhrase {
  id: number
  text: string
}

/** One slice's answer from the host: what it newly committed, and whether it is falling behind. */
export interface DictationAnswer {
  words?: string
  phrases?: DictationPhrase[]
  behind?: boolean
}

export interface DictationTranscript {
  /** The words committed since the last phrase closed, in the order they were said. */
  words: string
  /** The phrases finished so far, oldest first. */
  phrases: DictationPhrase[]
  /** Whether the host has said its decoding is behind. Said once, and kept. */
  behind: boolean
  /** Whether the take has been asked for and the host hasn't answered yet: "Preparing…". */
  preparing: boolean
}

/** A take that has heard nothing yet, and hasn't been asked for: the chunked path's transcript. */
export const EMPTY_TRANSCRIPT: DictationTranscript = {
  words: "",
  phrases: [],
  behind: false,
  preparing: false,
}

/** A take that has just started and is waiting on the host's answer. */
export function openingTranscript(): DictationTranscript {
  return { words: "", phrases: [], behind: false, preparing: true }
}

/** One space between the parts that have any words in them. */
function join(...parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
}

/** The host has answered: the model is loaded, whatever has been said so far. */
export function settled(transcript: DictationTranscript): DictationTranscript {
  return transcript.preparing ? { ...transcript, preparing: false } : transcript
}

/**
 * Folds one answer into a take. A closed phrase carries the words that were open in front of it, so
 * the open tail starts again after it. A finished phrase arrives already tidied (the host cleans it
 * once, before it commits it), and a phrase the take has already seen replaces that phrase's text
 * rather than appearing twice — the fold's own answer to a phrase that arrives again, which is also
 * what lets a raw phrase be replaced by its cleaned text without the take rewriting itself.
 */
export function hear(
  transcript: DictationTranscript,
  answer: DictationAnswer,
): DictationTranscript {
  const incoming = (answer.phrases ?? []).filter(
    (phrase) => phrase && Number.isFinite(phrase.id) && typeof phrase.text === "string",
  )
  let phrases = transcript.phrases
  for (const phrase of incoming) {
    const at = phrases.findIndex((seen) => seen.id === phrase.id)
    phrases =
      at < 0
        ? [...phrases, { id: phrase.id, text: phrase.text }]
        : phrases.map((seen, index) => (index === at ? { id: seen.id, text: phrase.text } : seen))
  }
  const fresh = typeof answer.words === "string" ? answer.words : ""
  const words = incoming.length ? join(fresh) : join(transcript.words, fresh)
  return {
    words,
    phrases,
    behind: transcript.behind || Boolean(answer.behind),
    preparing: transcript.preparing && !words && !phrases.length,
  }
}

/** The take as one piece of text: its phrases, then the words still open behind them. */
export function transcriptText(transcript: DictationTranscript): string {
  return join(...transcript.phrases.map((phrase) => phrase.text), transcript.words)
}

/** Whether there is anything to show in the bar's transcript. */
export function hearing(transcript: DictationTranscript | null | undefined): boolean {
  if (!transcript) return false
  return Boolean(
    transcript.words || transcript.phrases.length || transcript.preparing || transcript.behind,
  )
}
