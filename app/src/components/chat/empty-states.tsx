import { SettingsIcon } from "lucide-react"
import { Link } from "react-router"

import { Bot } from "@/components/bot"
import { DEFAULT_BOT_ID } from "@/components/bots"
import { RepoChips } from "@/components/repos"
import { Button } from "@/components/ui/button"
import { useReadyLine } from "@/lib/greeting"
import { SUGGESTIONS } from "@/lib/suggestions"
import type { RepoRef } from "@/lib/workspace"

/** What a chat or session not started yet says: the greeting, then one of the bot's lines. */
export function ReadyLine({ botId, id }: { botId?: string; id?: string }) {
  const { greeting, line } = useReadyLine(botId ?? DEFAULT_BOT_ID, id)
  return (
    <div className="flex max-w-xs flex-col gap-0.5 text-lg font-medium tracking-tight">
      {greeting && <p>{greeting}</p>}
      <p>{line}</p>
    </div>
  )
}

export const SETUP_COPY = "Point Gots at your Hermes Agent API server to start chatting."

export function EmptyState({
  botId,
  configured,
  session,
  id,
  line = true,
}: {
  botId?: string
  configured: boolean
  /** A project session not started yet: the repos it will work in. */
  session?: { repos: RepoRef[] }
  /** The chat or session on screen, none for a new chat. */
  id?: string
  line?: boolean
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 pt-24 pb-8 text-center">
      <Bot id={botId} animate className="size-24" />
      {configured ? (
        <div className="flex max-w-md flex-col items-center gap-3">
          {line && <ReadyLine botId={botId} id={id} />}
          {session && <RepoChips repos={session.repos} />}
        </div>
      ) : (
        <>
          <p className="max-w-sm text-sm text-muted-foreground">{SETUP_COPY}</p>
          <Button nativeButton={false} render={<Link to="/settings" replace />} size="lg">
            <SettingsIcon data-icon="inline-start" />
            Open settings
          </Button>
        </>
      )}
    </div>
  )
}

export function MainEmptyState({
  botId,
  id,
  onSend,
}: {
  botId?: string
  /** Main itself, so its line is the one it keeps. */
  id?: string
  onSend: (text: string) => Promise<void>
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 pt-24 pb-8 text-center">
      <Bot id={botId} animate className="size-24" />
      <ReadyLine botId={botId} id={id} />
      <div className="flex max-w-md flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((text) => (
          <Button
            key={text}
            variant="outline"
            className="h-auto min-h-10 rounded-full whitespace-normal"
            onClick={() => void onSend(text).catch(() => {})}
          >
            {text}
          </Button>
        ))}
      </div>
    </div>
  )
}
