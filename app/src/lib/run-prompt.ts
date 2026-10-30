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

/**
 * The prompt a run's status carries, as the host wrote it; nothing while the run waits on none. A
 * status that lists `pending_controls` holds at most one, so the newest is the one.
 */
export function promptEntry(status: unknown): Record<string, unknown> | undefined {
  const body = held(status)
  if (!body) return undefined
  const listed = Array.isArray(body.pending_controls) ? body.pending_controls : []
  return held(body.clarify) ?? held(body.approval) ?? held(listed.at(-1))
}

/** Which prompt an entry is: the host says so (`kind`), or the field only one of them carries does. */
export function promptKindOf(entry: Record<string, unknown>): "question" | "approval" {
  if (entry.kind === "approval") return "approval"
  if (entry.kind === "clarify") return "question"
  return "command" in entry ? "approval" : "question"
}

/** The prompt a run's status carries, as the screen waits on it. */
export function promptOf(status: unknown, runId: string): RunPrompt | undefined {
  const entry = promptEntry(status)
  if (!entry) return undefined
  // A prompt is answered by its id and the generation it was asked in, so one without both is not a
  // prompt a client can answer.
  if (typeof entry.prompt_id !== "string" || !entry.prompt_id) return undefined
  const base = {
    run: typeof entry.run_id === "string" && entry.run_id ? entry.run_id : runId,
    promptId: entry.prompt_id,
    generation: typeof entry.execution_generation === "number" ? entry.execution_generation : 0,
  }
  if (promptKindOf(entry) === "approval")
    return {
      kind: "approval",
      ...base,
      command: typeof entry.command === "string" ? entry.command : "",
      ...(typeof entry.description === "string" && entry.description
        ? { description: entry.description }
        : {}),
      choices: strings(entry.choices),
    }
  return {
    kind: "question",
    ...base,
    question: typeof entry.question === "string" ? entry.question : "",
    choices: strings(entry.choices),
    multiSelect: Boolean(entry.multi_select),
  }
}
