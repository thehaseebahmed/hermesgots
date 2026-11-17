import { useState } from "react"
import { CheckIcon, CopyIcon, ExternalLinkIcon, TrophyIcon } from "lucide-react"

import { Banner } from "@/components/banner"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import {
  LEADERBOARD_URL,
  leaveCommunity,
  onBoard,
  useCommunity,
  useJoin,
  type Verify,
} from "@/lib/community"
import { copyText, useCopied } from "@/lib/copied"
import { openExternal } from "@/lib/native"
import { tell } from "@/lib/tell"

const SHARED = [
  "Your GitHub username, shown as your name on the board",
  "Tokens used per day, model and mode (plan, auto, accept edits, chat)",
  "Counts from the last 35 days, sent when you join and kept up to date by your bots' hosts",
]

const NEVER =
  "Never shared: messages, prompts, files, repos, projects, session titles or your email."

const format = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

/** What joining shares, and what never leaves the device; shown wherever the join is offered. */
export function SharingNotes() {
  return (
    <div className="flex flex-col gap-3 px-2 text-sm text-muted-foreground">
      <ul className="flex list-disc flex-col gap-1.5 pl-5">
        {SHARED.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p>{NEVER}</p>
    </div>
  )
}

const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

/** The code GitHub's device flow asks for, with the way to GitHub and the way out. */
export function GitHubCode({ verify, onCancel }: { verify: Verify; onCancel: () => void }) {
  const { copied, noteCopied } = useCopied()
  return (
    <div className="flex flex-col gap-4 rounded-3xl bg-card p-5 text-card-foreground ring-1 ring-foreground/10">
      <span className="text-sm text-muted-foreground">Enter this code on GitHub</span>
      <div className="flex items-center gap-2">
        <output
          aria-live="polite"
          className="min-w-0 flex-1 font-mono text-2xl font-medium tracking-widest select-all"
        >
          {verify.userCode}
        </output>
        <Button
          variant="ghost"
          size="icon-lg"
          className="size-11 shrink-0"
          aria-label="Copy the code"
          onClick={() => void copyText(verify.userCode, noteCopied)}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
      <Button
        size="lg"
        className="h-11 rounded-full"
        onClick={() => openExternal(verify.verificationUri)}
      >
        Open GitHub <ExternalLinkIcon />
      </Button>
      <Button variant="ghost" size="lg" className="h-11 rounded-full" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  )
}

/** Settings > Community: the leaderboard switch, on by default from setup and off here. */
export function CommunitySettings() {
  const { me, setMe } = useCommunity()
  const [busy, setBusy] = useState(false)
  const { verify, start, cancel } = useJoin(setMe)
  const joined = me?.joined === true
  const shown = onBoard(me)

  const run = async (write: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await write()
    } catch (error) {
      tell.error(messageOf(error, "Couldn't change that"))
    } finally {
      setBusy(false)
    }
  }

  const change = (join: boolean) =>
    run(async () => {
      if (join) return start()
      cancel()
      setMe(await leaveCommunity())
    })

  if (me === undefined) return <Skeleton className="h-14 rounded-3xl" />

  return (
    <div className="flex flex-col gap-4">
      {me === null && <Banner tone="error">Couldn't read your community status.</Banner>}
      <label
        htmlFor="community"
        className="flex min-h-14 cursor-pointer items-center gap-4 rounded-3xl bg-card px-5 py-3 text-card-foreground ring-1 ring-foreground/10"
      >
        <TrophyIcon className="size-5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-base">Join the leaderboard</span>
          {shown && (
            <span className="truncate text-sm text-muted-foreground">Shown as @{me.login}</span>
          )}
          {joined && !shown && (
            <span className="truncate text-sm text-muted-foreground">Not on the board yet</span>
          )}
        </span>
        <Switch
          id="community"
          checked={joined || verify !== null}
          disabled={busy || me === null}
          onCheckedChange={(checked) => void change(checked)}
        />
      </label>
      {verify ? (
        <GitHubCode verify={verify} onCancel={cancel} />
      ) : joined && !shown ? (
        <Button
          size="lg"
          className="h-11 rounded-full"
          disabled={busy}
          onClick={() => void run(start)}
        >
          Confirm your GitHub username
        </Button>
      ) : onBoard(me) ? (
        <>
          <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-3xl bg-border ring-1 ring-foreground/10">
            {(
              [
                ["Today", me.totals.today],
                ["7 days", me.totals.week],
                ["30 days", me.totals.month],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1 bg-card px-5 py-4">
                <dt className="text-sm text-muted-foreground">{label}</dt>
                <dd className="text-xl font-medium tabular-nums">{format.format(value)}</dd>
              </div>
            ))}
          </dl>
          <Button
            variant="outline"
            size="lg"
            className="h-11 rounded-full"
            nativeButton={false}
            render={<a href={LEADERBOARD_URL} target="_blank" rel="noreferrer" />}
          >
            View the leaderboard <ExternalLinkIcon />
          </Button>
        </>
      ) : (
        <SharingNotes />
      )}
    </div>
  )
}
