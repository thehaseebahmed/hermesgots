/**
 * A bot's host as far as ntfy goes: it holds the profile's one target, the token included, answers
 * what a phone may read of it, and keeps every post it was made. The fake `plugin/ntfy.py` stands for.
 */
import { json } from "./component-kit.tsx"

export interface NtfyTarget {
  server?: string
  topic?: string
  token?: string
  devices: string[]
}

export function ntfyHost(held?: NtfyTarget) {
  const posts: { path: string; body: Record<string, unknown> }[] = []
  const host = { target: held }
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/plugins/gots/info"))
      return json({ name: "gots", features: ["push", "push_ntfy"] })
    if (!url.pathname.includes("/push/ntfy")) return json({})
    const shown = (device?: string | null) => ({
      object: "gots.push_ntfy",
      configured: Boolean(host.target?.server && host.target.topic && host.target.token),
      server: host.target?.server ?? null,
      topic: host.target?.topic ?? null,
      token_set: Boolean(host.target?.token),
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
    const next = { ...(host.target ?? { devices: [] }) } as Partial<NtfyTarget> & {
      devices: string[]
    }
    if (body.server !== undefined) {
      const server = String(body.server).replace(/\/+$/, "")
      if (next.server && next.server !== server) delete next.token
      next.server = server
    }
    if (body.topic !== undefined) next.topic = String(body.topic)
    if (body.token !== undefined) next.token = String(body.token)
    if (body.device) {
      if (!next.server || !next.topic || !next.token)
        return json(
          { error: { message: "Set this bot's ntfy server, topic and access token first." } },
          400,
        )
      next.devices = [...next.devices.filter((d) => d !== body.device), String(body.device)]
    }
    host.target = next as NtfyTarget
    return json(shown(body.device as string | undefined))
  }) as typeof fetch
  return { host, posts, restore: () => void (globalThis.fetch = real) }
}
