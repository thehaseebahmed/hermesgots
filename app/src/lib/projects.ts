import { useSyncExternalStore } from "react"

import { connectionKey } from "@/lib/connection"
import { listProjects, type HermesConfig, type HermesProject } from "@/lib/hermes"
import { createSignal } from "@/lib/store"

/**
 * Each server's Hermes Projects as last read, shared by the Code screen, a project and a session
 * that hasn't started, so they show the same list, and a read already on its way is joined rather
 * than sent again.
 */
let lists = new Map<string, HermesProject[]>()
const reading = new Map<string, Promise<HermesProject[]>>()
const { subscribe, notify } = createSignal()

/** Reads the server's projects now (or joins the read on its way) and shares the answer. */
export function readProjects(server: HermesConfig): Promise<HermesProject[]> {
  const key = connectionKey(server)
  let pending = reading.get(key)
  if (!pending) {
    pending = listProjects(server)
      .then((projects) => {
        // A new map, so screens reading every server's list see the change.
        lists = new Map(lists).set(key, projects)
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

/** Every server's projects as last read, by `connectionKey`. */
export function useAllProjects() {
  return useSyncExternalStore(subscribe, () => lists)
}

/** A project the host is still making: its first clone, or a repo being added or taken away. */
export function makingProject(project: HermesProject) {
  return (
    project.status === "cloning" ||
    project.folders.some((folder) => folder.status === "cloning" || folder.status === "removing")
  )
}

/** How far a project that isn't whole has got, as its row and its page both say it. */
export function cloneLine(project: HermesProject) {
  const total = project.folders.length
  if (!total) return "Creating…"
  const done = project.folders.filter((folder) => folder.status === "done").length
  return `Cloning ${Math.min(done + 1, total)} of ${total}`
}

/** What a failed clone says where the host gave no reason of its own. */
export const CLONE_FAILED = "Couldn't clone the project's repositories."
