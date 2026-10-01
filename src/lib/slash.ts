import { useEffect, useState } from "react"

import { getSettings } from "@/lib/db"
import { listSkills, type Skill } from "@/lib/hermes"

export type LocalCommand = "new" | "settings"

export type SlashItem =
  | { kind: "command"; name: LocalCommand; description: string }
  | { kind: "skill"; name: string; description?: string | null; category?: string | null }

export const LOCAL_COMMANDS: SlashItem[] = [
  { kind: "command", name: "new", description: "Start a new chat" },
  { kind: "command", name: "settings", description: "Open settings" },
]

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
let lastLoaded: Skill[] | null = null

async function loadSkills() {
  const { baseUrl, apiKey } = await getSettings()
  const key = `${baseUrl}\n${apiKey}`
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
export function useSlashItems(open: boolean, query: string) {
  const [state, setState] = useState<SkillsState>(
    lastLoaded ? { status: "ok", skills: lastLoaded } : { status: "loading" },
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    loadSkills().then(
      (skills) => {
        lastLoaded = skills
        if (!cancelled) setState({ status: "ok", skills })
      },
      () => !cancelled && setState({ status: "error" }),
    )
    return () => {
      cancelled = true
    }
  }, [open])

  const skills: SlashItem[] =
    state.status === "ok" ? state.skills.map((skill) => ({ kind: "skill", ...skill })) : []
  return { items: matches([...LOCAL_COMMANDS, ...skills], query), status: state.status }
}

export function optionId(listId: string, index: number) {
  return `${listId}-${index}`
}
