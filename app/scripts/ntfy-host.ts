/**
 * A bot's host as far as ntfy goes: it holds the profile's one target, the token included, answers
 * what a phone may read of it, and keeps every post it was made. The fake `plugin/ntfy.py` stands for.
 */
import { json } from "./component-kit.tsx"

export interface NtfyTarget {
  topic?: string
  devices: string[]
}

/** The profile's environment as Hermes reads it: its own ntfy server and token. */
export interface NtfyEnv {
  NTFY_SERVER_URL?: string
  NTFY_TOKEN?: string
  NTFY_TOPIC?: string
}

export function ntfyHost(held?: NtfyTarget, env: NtfyEnv = {}) {
  const posts: { path: string; body: Record<string, unknown> }[] = []
  const host = { target: held, env: { ...env } }
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/plugins/gots/info"))
      return json({ name: "gots", features: ["push", "push_ntfy"] })
    if (!url.pathname.includes("/push/ntfy")) return json({})
    const server = () => (host.env.NTFY_SERVER_URL || "https://ntfy.sh").replace(/\/+$/, "")
    const shown = (device?: string | null) => ({
      object: "gots.push_ntfy",
      configured: Boolean(host.target?.topic && host.env.NTFY_TOKEN),
      server: server(),
      server_set: Boolean(host.env.NTFY_SERVER_URL),
      topic: host.target?.topic ?? null,
      token_set: Boolean(host.env.NTFY_TOKEN),
      devices: host.target?.devices.length ?? 0,
      joined: Boolean(device && host.target?.devices.includes(device)),
    })
    if (init?.method !== "POST") return json(shown(url.searchParams.get("device")))
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    posts.push({ path: url.pathname, body })
    if (url.pathname.endsWith("/remove")) {
      host.target = body.device
        ? host.target && {
            ...host.target,
            devices: host.target.devices.filter((d) => d !== body.device),
          }
        : undefined
      return json(shown())
    }
    if (body.topic !== undefined && body.topic === host.env.NTFY_TOPIC)
      return json({ error: { message: "That's the topic Hermes listens on." } }, 400)
    const next = { ...(host.target ?? { devices: [] }) }
    if (body.topic !== undefined) next.topic = String(body.topic)
    if (body.server !== undefined)
      host.env.NTFY_SERVER_URL = String(body.server).replace(/\/+$/, "")
    if (body.token !== undefined) host.env.NTFY_TOKEN = String(body.token)
    if (body.device) {
      if (!next.topic || !host.env.NTFY_TOKEN)
        return json(
          { error: { message: "Set this bot's ntfy topic and Hermes's ntfy token first." } },
          400,
        )
      next.devices = [...next.devices.filter((d) => d !== body.device), String(body.device)]
    }
    host.target = next
    return json(shown(body.device as string | undefined))
  }) as typeof fetch
  return { host, posts, restore: () => void (globalThis.fetch = real) }
}
