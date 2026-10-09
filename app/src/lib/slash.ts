import { useEffect, useState } from "react"

import { listSkills, type HermesConfig, type Skill } from "@/lib/hermes"

export type LocalCommand = "new" | "settings"
/** Commands that carry the message after them, while a reply runs. */
export type SendMode = "steer" | "queue"

export type SlashItem =
  | { kind: "command"; name: LocalCommand | SendMode; description: string }
  | { kind: "skill"; name: string; description?: string | null; category?: string | null }

export const LOCAL_COMMANDS: SlashItem[] = [
  { kind: "command", name: "new", description: "Start a new chat" },
  { kind: "command", name: "settings", description: "Open settings" },
]

/** Offered only while a reply runs, when there is something to steer or wait for. */
export const SEND_COMMANDS: SlashItem[] = [
  { kind: "command", name: "steer", description: "Send to the running reply now" },
  { kind: "command", name: "queue", description: "Send after the reply" },
]

export const isSendMode = (name: string): name is SendMode => name === "steer" || name === "queue"

/** `/steer text` or `/queue text`: how to send the text, and the text. */
export function sendMode(text: string): { mode: SendMode; text: string } | null {
  const match = /^\/(steer|queue)(?:\s+([\s\S]*))?$/.exec(text.trimStart())
  return match ? { mode: match[1] as SendMode, text: (match[2] ?? "").trim() } : null
}

export function localCommand(text: string): LocalCommand | null {
  const name = text.trim().slice(1)
  return text.trim().startsWith("/") && LOCAL_COMMANDS.some((c) => c.name === name)
    ? (name as LocalCommand)
    : null
}

export type SkillsState =
  { status: "loading" } | { status: "ok"; skills: Skill[] } | { status: "error" }

// One request per server for the life of the page; a failure is forgotten so the next open retries.
const requests = new Map<string, Promise<Skill[]>>()
const loaded = new Map<string, Skill[]>()

function cacheKey({ baseUrl, apiKey }: HermesConfig) {
  return `${baseUrl}\n${apiKey}`
}

async function loadSkills({ baseUrl, apiKey }: HermesConfig) {
  const key = cacheKey({ baseUrl, apiKey })
  let pending = requests.get(key)
  if (!pending) {
    pending = listSkills({ baseUrl, apiKey })
    requests.set(key, pending)
    pending.catch(() => requests.delete(key))
  }
  return pending
}

function matches(items: SlashItem[], query: string) {
  const q = query.toLowerCase()
  if (!q) return items
  const starts: SlashItem[] = []
  const contains: SlashItem[] = []
  for (const item of items) {
    const name = item.name.toLowerCase()
    if (name.startsWith(q)) starts.push(item)
    else if (name.includes(q) || item.description?.toLowerCase().includes(q)) contains.push(item)
  }
  return [...starts, ...contains]
}

/** Local commands plus Hermes's skills, filtered by `query`. Skills load the first time it opens. */
export function useSlashItems(open: boolean, query: string, config: HermesConfig, busy = false) {
  const key = cacheKey(config)
  const [result, setResult] = useState<{ key: string; state: SkillsState } | null>(null)
  const cached = loaded.get(key)
  const state: SkillsState =
    result?.key === key
      ? result.state
      : cached
        ? { status: "ok", skills: cached }
        : { status: "loading" }

  const { baseUrl, apiKey } = config
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const key = cacheKey({ baseUrl, apiKey })
    loadSkills({ baseUrl, apiKey }).then(
      (skills) => {
        loaded.set(key, skills)
        if (!cancelled) setResult({ key, state: { status: "ok", skills } })
      },
      () => !cancelled && setResult({ key, state: { status: "error" } }),
    )
    return () => {
      cancelled = true
    }
  }, [open, baseUrl, apiKey])

  const skills: SlashItem[] =
    state.status === "ok" ? state.skills.map((skill) => ({ kind: "skill", ...skill })) : []
  return {
    items: matches([...LOCAL_COMMANDS, ...(busy ? SEND_COMMANDS : []), ...skills], query),
    status: state.status,
  }
}

export function optionId(listId: string, index: number) {
  return `${listId}-${index}`
}
