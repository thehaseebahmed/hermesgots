/**
 * The prompt a run is held up on, as the host keeps it on `GET /v1/runs/{id}`: the one read that a
 * client which joined the run late can recover the wait from, since a host only sends
 * `clarify.request` / `approval.request` to the subscribers it has at the time.
 *
 * Hermes names it in two places and both are the same prompt: on its status itself (`clarify`, and
 * `approval` while the run waits on one), and among `pending_controls`. Reading it here keeps one
 * account of where the fields are, whichever screen wants the prompt.
 */

/** A prompt the run waits on. Each question is a prompt of its own, one at a time. */
export type RunPrompt =
  | {
      kind: "question"
      run: string
      promptId: string
      generation: number
      question: string
      choices: string[]
      multiSelect: boolean
    }
  | {
      kind: "approval"
      run: string
      promptId: string
      generation: number
      command: string
      description?: string
      choices: string[]
    }

const held = (raw: unknown): Record<string, unknown> | undefined =>
  raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined

const strings = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((one): one is string => typeof one === "string") : []

/** The execution the prompt belongs to, which an answer names so a settled one cannot be re-raised. */
const generationOf = (entry: Record<string, unknown>) =>
  typeof entry.execution_generation === "number" ? entry.execution_generation : 0

const ENDED = ["completed", "cancelled", "failed", "interrupted"]

/** The prompts a status carries, newest first: `pending_controls` where it lists any, else its own. */
function promptEntries(status: unknown): Record<string, unknown>[] {
  const body = held(status)
  if (!body || (typeof body.status === "string" && ENDED.includes(body.status))) return []
  const listed = Array.isArray(body.pending_controls) ? body.pending_controls : []
  const pending = listed.flatMap((one): Record<string, unknown>[] => {
    const entry = held(one)
    return entry ? [entry] : []
  })
  if (pending.length) return pending.reverse()
  return [held(body.clarify), held(body.approval)].flatMap((one) => (one ? [one] : []))
}

/** A control this build does not know is no prompt at all, not a question by default. */
export function promptKindOf(entry: Record<string, unknown>): "question" | "approval" | undefined {
  if (entry.kind === "approval" || entry.event === "approval.request") return "approval"
  if (entry.kind === "clarify" || entry.event === "clarify.request") return "question"
  if ("command" in entry) return "approval"
  if ("question" in entry || "questions" in entry) return "question"
  return undefined
}

/** The newest prompt of one kind the status carries, as the host wrote it. */
export function promptEntry(
  status: unknown,
  kind: "question" | "approval",
): Record<string, unknown> | undefined {
  return promptEntries(status).find((entry) => promptKindOf(entry) === kind)
}

/** The question an entry asks: its own, or the first of Hermes's list of them, which carries its own. */
function askedOf(entry: Record<string, unknown>): Record<string, unknown> {
  const listed = Array.isArray(entry.questions) ? entry.questions : []
  return held(listed[0]) ?? entry
}

/** One prompt from a status entry or the event with the same fields; nothing where no route answers it. */
export function promptFrom(raw: unknown, runId: string): RunPrompt | undefined {
  const entry = held(raw)
  if (!entry || typeof entry.prompt_id !== "string" || !entry.prompt_id) return undefined
  const kind = promptKindOf(entry)
  if (!kind) return undefined
  const base = {
    run: typeof entry.run_id === "string" && entry.run_id ? entry.run_id : runId,
    promptId: entry.prompt_id,
    generation: generationOf(entry),
  }
  if (kind === "approval")
    return {
      kind,
      ...base,
      command: typeof entry.command === "string" ? entry.command : "",
      ...(typeof entry.description === "string" && entry.description
        ? { description: entry.description }
        : {}),
      choices: strings(entry.choices),
    }
  const asked = askedOf(entry)
  return {
    kind,
    ...base,
    question: typeof asked.question === "string" ? asked.question : "",
    choices: strings(asked.choices),
    multiSelect: Boolean(asked.multi_select),
  }
}

export function promptOf(status: unknown, runId: string): RunPrompt | undefined {
  for (const entry of promptEntries(status)) {
    const prompt = promptFrom(entry, runId)
    if (prompt) return prompt
  }
  return undefined
}
