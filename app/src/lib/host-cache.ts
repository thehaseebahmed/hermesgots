import { connectionKey } from "@/lib/connection"
import { db } from "@/lib/db"
import { noteFailure } from "@/lib/report"

type Server = { baseUrl: string; apiKey: string }

const keyOf = (server: Server, route: string) => `${connectionKey(server)}\n${route}`

/** The last answer a bot's host gave this page's route, or nothing where it never gave one. */
export async function cachedHost<T>(server: Server, route: string): Promise<T | undefined> {
  try {
    return (await db.hostCache.get(keyOf(server, route)))?.value as T | undefined
  } catch (error) {
    noteFailure(`Reading this device's copy of the host's ${route}`, error)
    return undefined
  }
}

/** Keeps a host's answer for the next open: this device's copy, never synced (ADR 0132). */
export async function keepHost(server: Server, route: string, value: unknown) {
  try {
    await db.hostCache.put({ key: keyOf(server, route), value })
  } catch (error) {
    noteFailure(`Keeping the host's ${route}`, error)
  }
}
