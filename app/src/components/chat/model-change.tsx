import { Divider } from "@/components/chat/divider"
import { formatTokens } from "@/lib/format"
import type { Compaction } from "@/lib/hermes"

/**
 * What changed in a chat between the turns either side of it: a squiggle broken by a word. The model
 * that took over, in its provider/model form; or that the host compacted the conversation. A label,
 * not a control — the pill under the composer is where a model is picked — so it takes no touch
 * target of its own. Both draw through the thread's one divider (ADR 0087): the words in the muted
 * colour at the thread's smallest size, the squiggle in the fainter border colour.
 *
 * A model change is a project session's alone. A chat draws the compaction too, since a chat's
 * context is compacted the same way, but a model a chat fell onto mid-run is a detail of that run
 * rather than a mark on the work.
 */

export function ModelChange({ model }: { model: string }) {
  return <Divider text={model} spoken={`Model switched to ${model}`} slot="model-change" />
}

/** How full the context was when the host compacted it, where the host recorded it. */
function size({ tokens, window }: Pick<Compaction, "tokens" | "window">) {
  if (!tokens) return ""
  if (!window) return ` · ${formatTokens(tokens)}`
  return ` · ${formatTokens(tokens)} of ${formatTokens(window)} (${Math.round((tokens / window) * 100)}%)`
}

/**
 * What the host recorded about a compaction. An in-place mark carries no size, so a divider drawn
 * inside a reply reads from this alone; one the record doesn't name is the same divider, or none.
 */
export function Compacted({ compaction }: { compaction?: Pick<Compaction, "tokens" | "window"> }) {
  const text = `Compaction${size(compaction ?? {})}`
  return <Divider text={text} spoken={text} slot="compaction" />
}
