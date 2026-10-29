import type { Attachment, Message, MessageStats, Seam, Steer, ToolEvent } from "../lib/db.ts"
import { actionOf, spawnStamp } from "../lib/spawn.ts"
import { clip, describeCall, parseArgs, patchStats, writeStats } from "../lib/tool-calls.ts"
import { appendThinking, type ReasoningRun } from "../lib/thinking.ts"
import { actionOfPreview, failureReason } from "../lib/tools.ts"

import type { ToolCall, Turn } from "./fold.ts"

/**
 * A thread's turns as the rows the app's message components draw (ADR 0065): the user's request,
 * then the reply with its words, its calls where they were made, its steers and its compactions.
 * Nothing here is stored; the ids are the turn's place in the thread, counted from `origin` (the
 * place the first turn holds, which older turns read later put below zero), so a row keeps its id
 * from one read to the next and the components' memos hold, and the scroller keeps the reader's
 * place while turns are added above.
 */
export function messagesOf(
  chat: string,
  turns: Turn[],
  options: { streaming?: boolean; stats?: Record<string, MessageStats>; origin?: number } = {},
): Message[] {
  return turns.flatMap((turn, at) => {
    const index = (options.origin ?? 0) + at
    const live = Boolean(options.streaming) && at === turns.length - 1 && !turn.done
    // What a turn cost: as it was just measured, else as the device kept it with the row that opened it.
    const stats = turn.stats ?? (turn.row !== undefined ? options.stats?.[turn.row] : undefined)
    // The page hands back the very turn it drew where nothing in it moved, so its rows are too.
    const key = `${turnId(chat, index)}-${live}`
    const held = drawn.get(turn)
    if (held?.key === key && held.stats === stats) return held.rows
    const rows = rowsOf(chat, turnId(chat, index), turn, live, stats)
    drawn.set(turn, { key, stats, rows })
    return rows
  })
}

/** The id a turn's rows are drawn under, from where it stands in the thread. */
export const turnId = (chat: string, index: number) => `${chat}-${index}`

/** The id of the reply row a turn draws, which is where its failure and Retry are drawn. */
export const replyId = (chat: string, index: number) => `${turnId(chat, index)}-a`

/**
 * The rows with the bytes this device holds for the files they carry, found by the path the host
 * saved each at: the transcript holds a marker and no bytes, and the device's own photos draw from
 * these while the host is away. `held` is undefined while the device is still reading what it
 * holds. A row that carries nothing held is the very row given.
 */
export function withHeldFiles(
  messages: Message[],
  held: ReadonlyMap<string, Blob> | undefined,
): Message[] {
  // Until the device has said what it holds, a file has no path to read from: asking the host for
  // bytes the device turns out to have would be a read for nothing.
  if (!held)
    return messages.map((message) =>
      message.attachments?.some((file) => file.path)
        ? {
            ...message,
            attachments: message.attachments.map(({ path: _path, ...file }) => file),
          }
        : message,
    )
  if (!held.size) return messages
  return messages.map((message) => {
    const files = message.attachments
    if (!files?.some((file) => file.path && !file.blob && held.has(file.path))) return message
    // The same row with the same bytes is the same object, so a streamed word elsewhere in the
    // thread never wakes the memo of a request that carries a photo.
    const blobs = files.map((file) => (file.path ? held.get(file.path) : undefined))
    const kept = overlaid.get(message)
    if (kept && kept.blobs.every((blob, at) => blob === blobs[at])) return kept.row
    const row = {
      ...message,
      attachments: files.map((file, at) =>
        !file.blob && blobs[at] ? { ...file, blob: blobs[at] } : file,
      ),
    }
    overlaid.set(message, { blobs, row })
    return row
  })
}

const overlaid = new WeakMap<Message, { blobs: (Blob | undefined)[]; row: Message }>()

const drawn = new WeakMap<Turn, { key: string; stats?: MessageStats; rows: Message[] }>()

function rowsOf(
  chat: string,
  id: string,
  turn: Turn,
  live: boolean,
  stats?: MessageStats,
): Message[] {
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
  if (live || content || tools.length || seams.length || thinking || turn.failed)
    rows.push({
      id: `${id}-a`,
      conversationId: chat,
      role: "assistant",
      content,
      ...(tools.length ? { tools } : {}),
      ...(thinking ? { reasoningRuns: thinking } : {}),
      ...(steers.length ? { steers } : {}),
      ...(seams.length ? { seams } : {}),
      ...(stats && !live ? { stats } : {}),
      status: live ? "streaming" : turn.failed ? "error" : "done",
      ...(turn.failed && !live ? { statusText: turn.failed.text } : {}),
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
