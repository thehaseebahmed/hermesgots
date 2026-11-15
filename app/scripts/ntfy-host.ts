/**
 * A bot's host as far as ntfy goes: it holds the profile's one target, the token included, answers
 * what a phone may read of it, and keeps every post it was made. The fake `plugin/ntfy.py` stands for.
 */
import { json } from "./component-kit.tsx"

export interface NtfyTarget {
  server: string
  topic: string
  token: string
  devices: string[]
}

export function ntfyHost(held?: NtfyTarget) {
  const posts: { path: string; body: Record<string, unknown> }[] = []
  const host = { target: held }
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.pathname.includes("/push/ntfy")) return json({})
    const shown = (device?: string | null) =>
      host.target
        ? {
            object: "gots.push_ntfy",
            configured: true,
            server: host.target.server,
            topic: host.target.topic,
            token_set: true,
            devices: host.target.devices.length,
            joined: Boolean(device && host.target.devices.includes(device)),
          }
        : { object: "gots.push_ntfy", configured: false }
    if (init?.method !== "POST") return json(shown(url.searchParams.get("device")))
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    posts.push({ path: url.pathname, body })
    if (url.pathname.endsWith("/remove")) {
      const left = host.target?.devices.filter((d) => d !== body.device) ?? []
      host.target = body.device && left.length ? { ...host.target!, devices: left } : undefined
      return json(shown())
    }
    const server = String(body.server).replace(/\/+$/, "")
    const same = host.target?.server === server && host.target?.topic === body.topic
    const token = (body.token as string | undefined) ?? (same ? host.target!.token : undefined)
    if (!token) return json({ error: { message: "An access token is required." } }, 400)
    const devices = same ? host.target!.devices.filter((d) => d !== body.device) : []
    host.target = {
      server,
      topic: String(body.topic),
      token,
      devices: body.device ? [...devices, String(body.device)] : devices,
    }
    return json(shown(body.device as string | undefined))
  }) as typeof fetch
  return { host, posts, restore: () => void (globalThis.fetch = real) }
}
