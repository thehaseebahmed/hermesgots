import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { RotateCwIcon } from "lucide-react"

import { Bot } from "@/components/bot"
import { CopyBlock } from "@/components/copy-block"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { db, type Profile } from "@/lib/db"
import {
  linkCommands,
  linkProfileCommand,
  mintLinkCode,
  useReachable,
  type LinkCode,
} from "@/lib/registry"
import { refreshBots } from "@/lib/sync"
import { cn } from "@/lib/utils"

/** While linking, the registry is read this often, so a bot shows up moments after it links. */
const POLL_MS = 3000

/** One code per app run until it expires, so reopening the sheet shows the same command. */
let current: LinkCode | undefined
let minting: Promise<LinkCode> | undefined

function mint() {
  minting ??= mintLinkCode().finally(() => {
    minting = undefined
  })
  return minting
}

/**
 * The commands that link a host, with a fresh link code, and the bots linked so far, each checked
 * from this device. `onReachable` reports whether any of them answers.
 */
export function LinkBots({ onReachable }: { onReachable?: (reachable: boolean) => void }) {
  const [code, setCode] = useState(() =>
    current && current.expiresAt - Date.now() > 60_000 ? current : undefined,
  )
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const bots = useLiveQuery(
    () => db.profiles.filter((p) => Boolean(p.hostId)).sortBy("createdAt"),
    [],
  )
  const [reachable, setReachable] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (code) {
      const timer = window.setTimeout(
        () => setCode(undefined),
        code.expiresAt - Date.now() - 60_000,
      )
      return () => window.clearTimeout(timer)
    }
    let cancelled = false
    mint().then(
      (minted) => {
        current = minted
        if (!cancelled) setCode(minted)
      },
      (reason) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)),
    )
    return () => {
      cancelled = true
    }
  }, [code, attempt])

  useEffect(() => {
    void refreshBots()
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshBots()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    onReachable?.(Boolean(bots?.some((bot) => !bot.disabled && reachable[bot.id])))
  }, [bots, reachable, onReachable])

  return (
    <div className="flex flex-col gap-5">
      <div className="space-y-2 text-sm">
        <p>Run these on your Hermes host:</p>
        {code ? (
          <CopyBlock label="Copy link commands" text={linkCommands(code.code)} />
        ) : error ? (
          <div className="flex items-center gap-2 rounded-2xl bg-muted p-3">
            <p className="flex-1 text-destructive" role="alert">
              {error}
            </p>
            <Button
              variant="ghost"
              className="h-11"
              onClick={() => {
                setError(undefined)
                setAttempt((n) => n + 1)
              }}
            >
              <RotateCwIcon data-icon="inline-start" />
              Retry
            </Button>
          </div>
        ) : (
          <div className="flex h-20 items-center justify-center rounded-2xl bg-muted">
            <Spinner />
          </div>
        )}
      </div>
      {code && (
        <div className="space-y-2 text-sm">
          <p>For each other profile:</p>
          <CopyBlock label="Copy profile command" text={linkProfileCommand(code.code)} />
        </div>
      )}
      <ul className="flex flex-col gap-2" aria-live="polite">
        {bots?.map((bot) => (
          <LinkedBot
            key={bot.id}
            profile={bot}
            onCheck={(ok) =>
              setReachable((state) => (state[bot.id] === ok ? state : { ...state, [bot.id]: ok }))
            }
          />
        ))}
        {bots?.length === 0 && (
          <li className="flex min-h-14 items-center gap-3 rounded-2xl border border-dashed border-foreground/25 px-3 text-sm text-muted-foreground">
            <Spinner />
            Waiting for a bot to link…
          </li>
        )}
      </ul>
    </div>
  )
}

function LinkedBot({ profile, onCheck }: { profile: Profile; onCheck: (ok: boolean) => void }) {
  const ok = useReachable(profile)
  useEffect(() => {
    if (ok !== undefined) onCheck(ok)
  }, [ok, onCheck])

  return (
    <li className="flex min-h-14 items-center gap-3 rounded-2xl bg-muted/60 px-3 py-2">
      <Bot id={profile.botId} className="size-9" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{profile.name}</p>
        <p className={cn("truncate text-xs text-muted-foreground", ok === false && "text-warning")}>
          {profile.disabled
            ? "Turned off"
            : ok === undefined
              ? "Checking…"
              : ok
                ? "Ready"
                : "Can't reach it from this device"}
        </p>
      </div>
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full bg-muted-foreground/40",
          ok && "bg-success",
          ok === false && "bg-warning",
        )}
      />
    </li>
  )
}

export function LinkSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent className="max-h-[90dvh]">
        <PopupHeader className="items-center pb-2">
          <PopupTitle>Link a bot</PopupTitle>
        </PopupHeader>
        <div className="px-6">{open && <LinkBots />}</div>
      </PopupContent>
    </Popup>
  )
}
