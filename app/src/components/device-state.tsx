import { useEffect, useState } from "react"

import { CopyBlock } from "@/components/copy-block"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Spinner } from "@/components/ui/spinner"
import { hasServer, serverConfig } from "@/lib/connection"
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
import {
  conversationsOf,
  db,
  getSettings,
  listProfiles,
  mainThreadId,
  type Profile,
} from "@/lib/db"
import { getPluginInfo, type PluginInfo } from "@/lib/hermes"
import { isNative } from "@/lib/native"
import { resumeTrace } from "@/lib/resume-trace"
import { lastOpened } from "@/lib/threads"
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

/** The host-and-pane answers one bot's state carries, with nulls where nothing was answered. */
const hostOf = (
  profile: Profile,
  info: PluginInfo | null,
  pane: { last?: string; stored: string | null },
): DiagHost => ({
  configured: hasServer(profile),
  pluginVersion: profile.pluginVersion ?? null,
  plugin: info?.version ?? null,
  features: info?.features ?? null,
  lastThread: pane.last ?? null,
  lastStored: pane.stored,
})

async function botState(profile: Profile): Promise<DiagBot> {
  const configured = hasServer(profile)
  const [rows, pane, mainRow, info] = await Promise.all([
    // Main is read by its own id; a stray main-flagged chat still rides in the window.
    conversationsOf(profile.id)
      .reverse()
      .filter((chat) => !chat.projectId)
      .limit(CHATS)
      .toArray(),
    lastOpened(profile.id),
    db.conversations.get(mainThreadId(profile.id)),
    configured ? getPluginInfo(serverConfig(profile)).catch(() => null) : null,
  ])
  const chats: DiagChat[] = rows.map((chat) => diagChat(chat))
  const main = mainRow ? await diagChat(mainRow, await messageCounts(mainRow.id)) : null
  return diagBot({ profile, host: hostOf(profile, info, pane), chats, main, threads: pane.threads })
}

/** A bot whose own reads failed: named and configured, and marked unread rather than empty. */
const unreadBot = (profile: Profile): DiagBot =>
  diagBot({
    profile,
    host: hostOf(profile, null, { stored: null }),
    chats: [],
    main: null,
    threads: 0,
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
    botThreads: Boolean(settings?.botThreads),
    chatNext: Boolean(settings?.chatNext),
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
