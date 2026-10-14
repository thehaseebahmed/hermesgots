import { useEffect } from "react"
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core"
import { useNavigate } from "react-router"

import { createStore } from "@/lib/store"
import { skipLaunchRestore } from "@/lib/launch"
import { isNative } from "@/lib/native"
import { randomId } from "@/lib/utils"

/** What another app shared into Gots, through Android's share sheet or the PWA's share target. */
export interface IncomingShare {
  id: string
  /** The page or item's title, when the sender gave one. */
  title?: string
  /** Shared text, without the links in it. */
  text?: string
  links: string[]
  images: File[]
}

const LINK = /\bhttps?:\/\/[^\s<>"']+/gi

/** Splits a share into its links and the rest, the way senders mix them (a title, then the URL). */
export function toShare(input: { title?: string; text?: string; url?: string; images?: File[] }) {
  const links = new Set<string>()
  const add = (link: string) => links.add(link.replace(/[.,;:!?)\]]+$/, ""))
  if (input.url?.trim()) add(input.url.trim())
  const text = (input.text ?? "").replace(LINK, (link) => {
    add(link)
    return ""
  })
  const rest = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  const title = input.title?.trim()
  return {
    id: randomId(),
    title: title || undefined,
    text: rest && rest !== title ? rest : undefined,
    links: [...links],
    images: input.images ?? [],
  } satisfies IncomingShare
}

/** The message a share becomes: the user's note, then what was shared. */
export function shareText(share: IncomingShare, note: string) {
  const shared = [share.links.length ? share.title : undefined, share.text, ...share.links]
  return [note.trim(), shared.filter(Boolean).join("\n")].filter(Boolean).join("\n\n")
}

const current = createStore<IncomingShare | null>(null)
const setShare = current.set

export const clearShare = () => setShare(null)

export const useIncomingShare = current.use

const SHARE_CACHE = "memento-share"

/** Reads a share the service worker took (`public/share-sw.js`), then forgets it. */
export async function readWebShare(id: string) {
  if (!("caches" in window)) return false
  try {
    const cache = await caches.open(SHARE_CACHE)
    const meta = await cache.match(`/__share/${id}`)
    if (!meta) return false
    const { title, text, url, files } = (await meta.json()) as {
      title?: string
      text?: string
      url?: string
      files: { key: string; name: string; type: string }[]
    }
    const images: File[] = []
    for (const file of files) {
      const response = await cache.match(file.key)
      if (response) images.push(new File([await response.blob()], file.name, { type: file.type }))
    }
    setShare(toShare({ title, text, url, images }))
    return true
  } catch {
    return false
  } finally {
    void caches.delete(SHARE_CACHE).catch(() => {})
  }
}

interface NativeShare {
  title: string
  text: string
  files: { path: string; name: string; type: string }[]
}

interface ShareTargetPlugin {
  addListener(event: "share", listener: (share: NativeShare) => void): Promise<PluginListenerHandle>
}

const ShareTarget = registerPlugin<ShareTargetPlugin>("ShareTarget")

async function fromNative(share: NativeShare) {
  const images: File[] = []
  for (const file of share.files) {
    try {
      const blob = await (await fetch(Capacitor.convertFileSrc(file.path))).blob()
      images.push(new File([blob], file.name, { type: file.type || blob.type }))
    } catch {
      // A file that can't be read is left out; the rest still goes.
    }
  }
  return toShare({ title: share.title, text: share.text, images })
}

/**
 * Opens the share screen when another app shares into the Android app, including the share that
 * launched it. In development, `window.mementoShare({ title, text, url, images })` does the same.
 */
export function useShareReceiver() {
  const navigate = useNavigate()
  useEffect(() => {
    const open = (share: IncomingShare) => {
      skipLaunchRestore()
      setShare(share)
      navigate("/share")
    }
    if (import.meta.env.DEV) {
      const dev = window as unknown as { mementoShare?: (input: object) => void }
      dev.mementoShare = (input) => open(toShare(input))
    }
    if (!isNative) return
    let handle: PluginListenerHandle | undefined
    let cancelled = false
    void ShareTarget.addListener("share", (share) => {
      void fromNative(share).then(open)
    }).then((added) => {
      if (cancelled) void added.remove()
      else handle = added
    })
    return () => {
      cancelled = true
      void handle?.remove()
    }
  }, [navigate])
}
