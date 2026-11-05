import type { InterfaceDraw } from "@/lib/openui-thread.ts"

import { parser } from "./library.tsx"

export type Props = {
  source: string
  open: boolean
  streaming: boolean
  draw: InterfaceDraw["kind"]
}

export type Answer = "draw" | "code" | "nothing"

export type Verdict = {
  answer: Answer
  failure: unknown
  /** Why a settled block has nothing to draw, where the failure is the gate's own reason. */
  reason?: "no-root"
}

/**
 * The fallback ladder, first match wins. `nothing` while a reply is still writing is what keeps a
 * healthy block's own prefixes (`root`, `root =`, `c = Card("Hi")` all parse to no root) from
 * flashing their fenced source on every flush: only a settled answer may say `code`.
 */
export function gate({ source, open, streaming, draw }: Props): Verdict {
  if (draw === "patch")
    return open && !streaming
      ? { answer: "code", failure: new Error("a patch's fence never closed in a stopped reply") }
      : { answer: "nothing", failure: undefined }
  if (draw === "orphan") return { answer: "code", failure: new Error("a patch naming nothing") }
  if (open && !streaming)
    return { answer: "code", failure: new Error("a fence that never closed in a stopped reply") }

  let result: ReturnType<typeof parser.parse>
  try {
    result = parser.parse(source)
  } catch (failure) {
    return { answer: "code", failure }
  }
  const { errors } = result.meta
  // `no-root` is a warning when the program calls the root component, and such a program still draws.
  const fatal = errors.some((error) => error.severity !== "warning")
  if (result.root && !fatal) return { answer: "draw", failure: undefined }
  if (streaming) return { answer: "nothing", failure: undefined }
  if (errors[0]) return { answer: "code", failure: errors[0] }
  return {
    answer: "code",
    failure: new Error("a settled source with no drawable root"),
    reason: "no-root",
  }
}

function wordsOf(failure: unknown): string | null {
  if (failure instanceof Error) return failure.message
  if (failure && typeof failure === "object" && "message" in failure)
    return String((failure as { message: unknown }).message)
  return null
}

// Asks the reply's own gate so the playground cannot disagree with a thread about what parses; only
// no-root is reworded, since the thread's message is a diagnostic.
export function blockProblem(source: string): string | null {
  const { answer, failure, reason } = gate({
    source,
    open: false,
    streaming: false,
    draw: "interface",
  })
  if (answer === "draw") return null
  if (reason === "no-root") return "This block has no root = Stack(...) to draw."
  return wordsOf(failure) ?? "This block does not draw."
}
