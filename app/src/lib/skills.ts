import { useEffect, useState } from "react"

import { connectionKey } from "@/lib/connection"
import { lacksRoute } from "@/lib/cooldown"
import { db } from "@/lib/db"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import { listSkills, type HermesConfig, type Skill } from "@/lib/hermes"

export type SkillsState =
  { status: "loading" } | { status: "ok"; skills: Skill[] } | { status: "error" }

// This page's answer, so a second open in the same page needs no read; the device keeps the row.
const memory = new Map<string, Skill[]>()
// One read per server at a time: an open while one is in flight joins it rather than asking again.
const inFlight = new Map<string, Promise<Skill[]>>()

async function readStored(key: string) {
  return (await db.skills.get(key))?.skills
}

/** Reads the profile's skills for this server and keeps them, unless the bot can't list them. */
function readSkills(config: HermesConfig, key: string): Promise<Skill[]> {
  const pending = inFlight.get(key)
  if (pending) return pending
  const request = (async () => {
    try {
      const skills = await listSkills(config, AbortSignal.timeout(READ_TIMEOUT_MS))
      memory.set(key, skills)
      // Don't write what didn't change: a fresh row would wake anything reading this one.
      if (JSON.stringify(await readStored(key)) !== JSON.stringify(skills)) {
        await db.skills.put({ id: key, skills })
      }
      return skills
    } catch (error) {
      // A plugin with no skills route (an older one) has none to offer, so the menu shows the commands
      // alone and nothing is remembered for it, leaving room for an upgraded plugin to fill it in.
      // A host that is away, busy or slow is not that answer: the cached list stands and this read fails.
      if (await lacksRoute(config, error, "skills")) return []
      throw error
    }
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, request)
  return request
}

/**
 * The bot's skills as the device last knew them, read again in the background while `open`. What is
 * cached answers at once and stands if a read fails, so the menu never opens empty on a bot whose
 * host is away; a bot whose plugin has no skills route has none to show.
 */
export function useSkills(config: HermesConfig | null, open: boolean): SkillsState {
  const key = config?.baseUrl.trim() ? connectionKey(config) : ""
  const [result, setResult] = useState<{ key: string; state: SkillsState } | null>(null)
  const known = key ? memory.get(key) : undefined
  const state: SkillsState =
    result?.key === key
      ? result.state
      : known
        ? { status: "ok", skills: known }
        : key
          ? { status: "loading" }
          : { status: "ok", skills: [] }

  const baseUrl = config?.baseUrl
  const apiKey = config?.apiKey
  // A page that has never read this bot's skills starts from the device's copy of them, and only
  // while nothing else has answered for it yet.
  useEffect(() => {
    if (!key || memory.has(key)) return
    let cancelled = false
    void readStored(key).then((skills) => {
      if (!skills || cancelled) return
      memory.set(key, skills)
      setResult((current) =>
        current?.key === key ? current : { key, state: { status: "ok", skills } },
      )
    })
    return () => {
      cancelled = true
    }
  }, [key])

  useEffect(() => {
    if (!open || !baseUrl || !apiKey) return
    let cancelled = false
    readSkills({ baseUrl, apiKey }, key).then(
      (skills) => !cancelled && setResult({ key, state: { status: "ok", skills } }),
      // A failed read leaves the cached list standing: nothing to report, nothing to lose.
      () =>
        !cancelled &&
        setResult((current) =>
          current?.key === key ? current : { key, state: { status: "error" } },
        ),
    )
    return () => {
      cancelled = true
    }
  }, [open, key, baseUrl, apiKey])

  return state
}
