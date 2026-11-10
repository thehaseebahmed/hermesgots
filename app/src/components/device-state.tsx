import { useEffect, useState } from "react"

import { CopyBlock } from "@/components/copy-block"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Spinner } from "@/components/ui/spinner"
import { hasServer, serverConfig } from "@/lib/connection"
import { listsAsChat } from "@/lib/lists-as-chat"
import {
  diagBot,
  diagChat,
  diagResume,
  formatDiagnostics,
  type DiagBot,
  type DiagChat,
  type DiagDevice,
  type DiagHost,
} from "@/lib/diagnostics"
import { conversationsOf, db, getSettings, listProfiles, type Profile } from "@/lib/db"
import { getPluginInfo, type PluginInfo } from "@/lib/hermes"
import { isNative } from "@/lib/native"
import { resumeTrace } from "@/lib/resume-trace"
import { legacyChatOn } from "@/lib/legacy-chat"
import { landingChat, lastChatOf } from "@/lib/last-chat"
import { MIN_PLUGIN_VERSION } from "@/lib/version"

/** The newest chats each bot's state names, so a busy bot can't make the dump unbounded. */
const CHATS = 100

/** The host-and-pane answers one bot's state carries, with nulls where nothing was answered. */
const hostOf = (
  profile: Profile,
  info: PluginInfo | null,
  pane: { last: string | null; stored: string | null },
): DiagHost => ({
  configured: hasServer(profile),
  pluginVersion: profile.pluginVersion ?? null,
  plugin: info?.version ?? null,
  features: info?.features ?? null,
  lastThread: pane.last,
  lastStored: pane.stored,
})

async function botState(profile: Profile): Promise<DiagBot> {
  const configured = hasServer(profile)
  const chats = conversationsOf(profile.id).reverse().filter(listsAsChat)
  const [rows, last, info] = await Promise.all([
    chats.clone().limit(CHATS).toArray(),
    landingChat(profile.id),
    configured ? getPluginInfo(serverConfig(profile)).catch(() => null) : null,
  ])
  const drawn: DiagChat[] = rows.map((chat) => diagChat(chat))
  const pane = { last: last ?? null, stored: lastChatOf(profile.id) }
  return diagBot({ profile, host: hostOf(profile, info, pane), chats: drawn })
}

/** A bot whose own reads failed: named and configured, and marked unread rather than empty. */
const unreadBot = (profile: Profile): DiagBot =>
  diagBot({
    profile,
    host: hostOf(profile, null, { last: null, stored: null }),
    chats: [],
    unread: true,
  })

/** Everything the device holds that a bug about a stuck screen needs to be read from afar. */
export async function readDeviceDiagnostics(): Promise<DiagDevice> {
  const [settings, profiles] = await Promise.all([getSettings(), listProfiles()])
  const bots = await Promise.all(
    profiles.map((profile) => botState(profile).catch(() => unreadBot(profile))),
  )
  const trace = resumeTrace()
  return {
    at: new Date().toISOString(),
    app: __APP_VERSION__,
    minPlugin: MIN_PLUGIN_VERSION,
    native: isNative,
    route: window.location.pathname,
    schema: db.verno,
    developer: Boolean(settings?.developer),
    botThreads: !legacyChatOn(settings),
    ...(trace ? { resume: diagResume(trace) } : {}),
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
  const [text, setText] = useState<string>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!open) return
    let current = true
    setText(undefined)
    setError(undefined)
    void readDeviceDiagnostics()
      .then((device) => current && setText(formatDiagnostics(device)))
      .catch(
        (reason) => current && setError(reason instanceof Error ? reason.message : String(reason)),
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
          {text ? (
            <CopyBlock text={text} label="Copy device state" />
          ) : error ? (
            <p className="text-sm text-muted-foreground">
              Could not read the device state: {error}
            </p>
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
