import { useEffect, useState } from "react"

import { connectionKey } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { db } from "@/lib/db"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import { listSkills, type HermesConfig, type Skill } from "@/lib/hermes"
import { noteFailure } from "@/lib/report"
import { skillsState, type SkillsState } from "@/lib/skills-cache"

export type { SkillsState } from "@/lib/skills-cache"

// This page's answer, so a second open in the same page needs no read; the device keeps the row.
const memory = new Map<string, Skill[]>()
// One read per server at a time: an open while one is in flight joins it rather than asking again.
const inFlight = new Map<string, Promise<Skill[]>>()
// A plugin that answered 404 for the route: left alone for the window, as every other read of a
// route a plugin lacks is, so an older plugin is asked once per window instead of once per open.
const unsupported = cooldown()

async function readStored(key: string) {
  return (await db.skills.get(key))?.skills
}

/** Reads the profile's skills for this server and keeps them, unless the bot can't list them. */
function readSkills(config: HermesConfig, key: string): Promise<Skill[]> {
  const pending = inFlight.get(key)
  if (pending) return pending
  if (unsupported.cooling(key)) return Promise.resolve([])
  const request = (async () => {
    let skills: Skill[]
    try {
      skills = await listSkills(config, AbortSignal.timeout(READ_TIMEOUT_MS))
    } catch (error) {
      // A plugin with no skills route (an older one) has none to offer, so the menu shows the
      // commands alone; the plugin is left alone for a while and an upgrade fills the list in then.
      if (await lacksRoute(config, error, "skills")) {
        unsupported.start(key)
        return []
      }
      // A host that is away, busy or slow is not that answer: the held list stands, and the failure
      // is noted like every other read the app carries on from.
      noteFailure("Reading the bot's skills", error)
      throw error
    }
    unsupported.clear(key)
    memory.set(key, skills)
    try {
      // Keeping the row is a favour to the next page load, not part of the answer: a Dexie failure
      // here (a blocked upgrade, a full quota) must not throw away what the host just sent.
      // Don't write what didn't change: a fresh row would wake anything reading this one.
      if (JSON.stringify(await readStored(key)) !== JSON.stringify(skills)) {
        await db.skills.put({ id: key, skills })
      }
    } catch (error) {
      noteFailure("Saving the bot's skills", error)
    }
    return skills
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, request)
  return request
}

/**
 * The bot's skills as this page last knew them, read again in the background while `open`: what the
 * page holds answers at once and a read that lands replaces it, so a skill installed a moment ago
 * shows without a reload, and a read that fails leaves it standing, so the menu never opens empty on
 * a bot whose host is away. A bot whose plugin has no skills route has none to show.
 */
export function useSkills(config: HermesConfig | null, open: boolean): SkillsState {
  // A bot the app reads plugin routes for at all: with no key, no route is read, as everywhere else.
  const key = config?.baseUrl.trim() && config.apiKey ? connectionKey(config) : ""
  // The read that has finished for this bot, as a fresh object each time: a read that lands must
  // render even when one has landed for this bot before, and the list itself lives in `memory`.
  const [settled, setSettled] = useState<{ key: string } | null>(null)
  const state = skillsState({
    key,
    known: key ? memory.get(key) : undefined,
    settled: settled?.key ?? null,
  })

  const baseUrl = config?.baseUrl
  const apiKey = config?.apiKey
  // A page that has never read this bot's skills starts from the device's copy of them. An answer
  // the page already holds is the fresher one, so the row only fills that gap, and a row that can't
  // be read is no worse than no row at all.
  useEffect(() => {
    if (!key || memory.has(key)) return
    let cancelled = false
    void readStored(key)
      .then((skills) => {
        if (cancelled || !skills || memory.has(key)) return
        memory.set(key, skills)
        setSettled({ key })
      })
      .catch((error: unknown) => noteFailure("Reading the bot's saved skills", error))
    return () => {
      cancelled = true
    }
  }, [key])

  // The read behind each open replaces what the page holds (and the device's row with it); a read
  // that fails leaves it standing, and all this records is that the read is over, so the menu stops
  // waiting on it and shows the commands alone.
  useEffect(() => {
    if (!open || !baseUrl || !apiKey) return
    let cancelled = false
    const done = () => {
      if (!cancelled) setSettled({ key })
    }
    readSkills({ baseUrl, apiKey }, key).then(done, done)
    return () => {
      cancelled = true
    }
  }, [open, key, baseUrl, apiKey])

  return state
}
