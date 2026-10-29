import type { Attachment, Message, Seam, Steer, ToolEvent } from "../lib/db.ts"
import { actionOf, spawnStamp } from "../lib/spawn.ts"
import { clip, describeCall, parseArgs, patchStats, writeStats } from "../lib/tool-calls.ts"
import { appendThinking, type ReasoningRun } from "../lib/thinking.ts"
import { actionOfPreview, failureReason } from "../lib/tools.ts"

import type { ToolCall, Turn } from "./fold.ts"

/**
 * A thread's turns as the rows the app's message components draw (ADR 0065): the user's request,
 * then the reply with its words, its calls where they were made, its steers and its compactions.
 * Nothing here is stored; the ids are the turn's place in the thread, so a row keeps its id from one
 * read to the next and the components' memos hold.
 */
export function messagesOf(
  chat: string,
  turns: Turn[],
  options: { streaming?: boolean } = {},
): Message[] {
  return turns.flatMap((turn, index) => {
    const live = Boolean(options.streaming) && index === turns.length - 1 && !turn.done
    // The page hands back the very turn it drew where nothing in it moved, so its rows are too.
    const key = `${chat}-${index}-${live}`
    const held = drawn.get(turn)
    if (held?.key === key) return held.rows
    const rows = rowsOf(chat, `${chat}-${index}`, turn, live)
    drawn.set(turn, { key, rows })
    return rows
  })
}

const drawn = new WeakMap<Turn, { key: string; rows: Message[] }>()

function rowsOf(chat: string, id: string, turn: Turn, live: boolean): Message[] {
  const createdAt = turn.at ?? 0
  const rows: Message[] = []
  // A wake turn answers no message of the user's, and a carried one's request went with the archive.
  if (!turn.wake && !turn.carried && (turn.user || turn.files?.length))
    rows.push({
      id: `${id}-u`,
      conversationId: chat,
      role: "user",
      content: turn.user,
      ...(turn.files?.length
        ? {
            attachments: turn.files.map((file, at): Attachment => ({
              id: `${id}-f${at}`,
              ...file,
            })),
          }
        : {}),
      status: "done",
      createdAt,
    })
  let content = ""
  const tools: ToolEvent[] = []
  const steers: Steer[] = []
  const seams: Seam[] = []
  let thinking: ReasoningRun[] | undefined
  // Thinking continues the run the last call opened, as the transcript parse draws it.
  const think = (text: string | undefined) => {
    if (text) thinking = appendThinking(thinking, tools.at(-1)?.toolCallId, text, true)
  }
  for (const part of turn.parts) {
    if (part.kind === "text") {
      think(part.thought)
      if (part.text) content = content ? `${content}\n\n${part.text}` : part.text
    } else if (part.kind === "tools")
      for (const call of part.calls) {
        think(call.thought)
        tools.push(toolOf(call, content.length, createdAt, live))
      }
    else if (part.kind === "steer")
      steers.push({
        id: `${id}-s${steers.length}`,
        text: part.text,
        contentOffset: content.length,
        at: createdAt,
      })
    else
      seams.push({
        id: `${id}-c${seams.length}`,
        row: part.row ?? -1,
        contentOffset: content.length,
        toolsBefore: tools.length,
        at: part.at ?? createdAt,
      })
  }
  think(turn.pendingThought)
  if (live || content || tools.length || seams.length || thinking)
    rows.push({
      id: `${id}-a`,
      conversationId: chat,
      role: "assistant",
      content,
      ...(tools.length ? { tools } : {}),
      ...(thinking ? { reasoningRuns: thinking } : {}),
      ...(steers.length ? { steers } : {}),
      ...(seams.length ? { seams } : {}),
      status: live ? "streaming" : "done",
      createdAt,
    })
  return rows
}

/** A call as a tool row: named and worded as the transcript's parse words it, timed where it can be. */
function toolOf(call: ToolCall, offset: number, turnAt: number, live: boolean): ToolEvent {
  const args = call.arguments === undefined ? undefined : parseArgs(call.arguments)
  // A streamed call has only the host's preview, which already names what the call is about.
  const described =
    args === undefined
      ? { name: call.name, label: call.label ?? "", args: undefined }
      : describeCall(call.name, args)
  const action =
    args === undefined
      ? actionOfPreview(call.name, call.label)
      : (actionOf(described.args) ?? spawnStamp(described.name, described.args))
  const stats = writeStats(described.name, described.args)
  const startedAt = call.startedAt ?? turnAt
  const tool: ToolEvent = {
    toolCallId: call.id,
    tool: described.name,
    label: clip(described.label) || described.name,
    status: call.result === undefined && live ? "running" : "completed",
    startedAt,
    ...(call.result !== undefined || !live ? { endedAt: call.endedAt ?? startedAt } : {}),
    contentOffset: offset,
    ...(action ? { action } : {}),
    ...stats,
    ...(stats ? { created: true } : {}),
  }
  if (call.result) {
    tool.result = clip(call.result)
    if (tool.tool === "patch") Object.assign(tool, patchStats(call.result))
    // Hermes doesn't store whether a call failed; its result says, as Hermes itself reads it.
    const error = failureReason(tool.tool, call.result)
    if (error) Object.assign(tool, { status: "failed", error })
  }
  return tool
}
