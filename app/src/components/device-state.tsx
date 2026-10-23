import { useEffect, useState } from "react"

import { CopyBlock } from "@/components/copy-block"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Spinner } from "@/components/ui/spinner"
import { serverConfig } from "@/lib/connection"
import {
  diagBot,
  diagChat,
  formatDiagnostics,
  type DiagBot,
  type DiagChat,
  type DiagDevice,
} from "@/lib/diagnostics"
import { conversationsOf, db, getSettings, listProfiles, type Profile } from "@/lib/db"
import { getPluginFeatureList, getPluginVersion } from "@/lib/hermes"
import { isNative } from "@/lib/native"
import { MIN_PLUGIN_VERSION } from "@/lib/version"

/** The newest chats each bot's state names, so a busy bot can't make the dump unbounded. */
const CHATS = 100

async function messageCounts(id: string) {
  const [user, assistant] = await Promise.all([
    db.messages.where("[conversationId+role]").equals([id, "user"]).count(),
    db.messages.where("[conversationId+role]").equals([id, "assistant"]).count(),
  ])
  return { user, assistant }
}

async function botState(profile: Profile): Promise<DiagBot> {
  const chats = (
    await conversationsOf(profile.id)
      .filter((chat) => !chat.projectId)
      .toArray()
  )
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-CHATS)
  const main = chats.find((chat) => chat.main)
  const mapped: DiagChat[] = await Promise.all(
    chats.map(async (chat) =>
      diagChat(chat, chat.id === main?.id ? await messageCounts(chat.id) : undefined),
    ),
  )
  const configured = Boolean(profile.baseUrl.trim()) && Boolean(profile.apiKey)
  const [plugin, features] = configured
    ? await Promise.all([
        getPluginVersion(serverConfig(profile)),
        getPluginFeatureList(serverConfig(profile)),
      ])
    : []
  let lastThread: string | null = null
  try {
    lastThread = localStorage.getItem(`memento:last-thread:${profile.id}`)
  } catch {
    // Storage can be blocked; the state then reads no thread.
  }
  return diagBot(profile, mapped, { plugin, features, lastThread })
}

/** Everything the device holds that a bug about a stuck screen needs to be read from afar. */
export async function readDeviceDiagnostics(): Promise<DiagDevice> {
  const [settings, profiles] = await Promise.all([getSettings(), listProfiles()])
  const bots = await Promise.all(profiles.map(botState))
  return {
    at: new Date().toISOString(),
    app: __APP_VERSION__,
    minPlugin: MIN_PLUGIN_VERSION,
    native: isNative,
    route: window.location.pathname,
    schema: db.verno,
    developer: Boolean(settings?.developer),
    botThreads: Boolean(settings?.botThreads),
    bots,
  }
}

/** Settings' Device state: the dump above, shown and copied as one block. */
export function DeviceStateSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [state, setState] = useState<string>()
  useEffect(() => {
    if (!open) return
    let current = true
    setState(undefined)
    void readDeviceDiagnostics()
      .then((device) => current && setState(formatDiagnostics(device)))
      .catch(
        (error) =>
          current &&
          setState(
            JSON.stringify(
              { error: error instanceof Error ? error.message : String(error) },
              null,
              2,
            ),
          ),
      )
    return () => {
      current = false
    }
  }, [open])

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader className="pb-2">
          <PopupTitle>Device state</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-6">
          {state ? (
            <CopyBlock text={state} label="Copy device state" />
          ) : (
            <div className="flex items-center justify-center py-8">
              <Spinner className="size-6" />
            </div>
          )}
        </div>
      </PopupContent>
    </Popup>
  )
}
