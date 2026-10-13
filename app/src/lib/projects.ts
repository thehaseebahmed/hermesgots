import { useSyncExternalStore } from "react"

import { connectionKey } from "@/lib/connection"
import { listProjects, type HermesConfig, type HermesProject } from "@/lib/hermes"
import { createSignal } from "@/lib/store"

/**
 * Each server's Hermes Projects as last read, shared by the Code screen, a project and a session
 * that hasn't started, so they show the same list, and a read already on its way is joined rather
 * than sent again.
 */
const lists = new Map<string, HermesProject[]>()
const reading = new Map<string, Promise<HermesProject[]>>()
const { subscribe, notify } = createSignal()

/** Reads the server's projects now (or joins the read on its way) and shares the answer. */
export function readProjects(server: HermesConfig): Promise<HermesProject[]> {
  const key = connectionKey(server)
  let pending = reading.get(key)
  if (!pending) {
    pending = listProjects(server)
      .then((projects) => {
        lists.set(key, projects)
        notify()
        return projects
      })
      .finally(() => reading.delete(key))
    reading.set(key, pending)
  }
  return pending
}

/** The server's projects as last read, or undefined before the first answer. */
export function useProjects(server: HermesConfig | undefined) {
  const key = server ? connectionKey(server) : ""
  return useSyncExternalStore(subscribe, () => (key ? lists.get(key) : undefined))
}
