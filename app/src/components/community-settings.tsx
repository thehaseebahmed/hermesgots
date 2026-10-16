import { useState } from "react"
import { ExternalLinkIcon, TrophyIcon } from "lucide-react"
import { toast } from "sonner"

import { Banner } from "@/components/banner"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { LEADERBOARD_URL, joinCommunity, leaveCommunity, useCommunity } from "@/lib/community"

const SHARED = [
  "Your GitHub username, shown as your name on the board",
  "Tokens used per day, model and mode (plan, auto, accept edits, goal, chat)",
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

/** Settings > Community: the leaderboard switch, on by default from setup and off here. */
export function CommunitySettings() {
  const { me, setMe } = useCommunity()
  const [busy, setBusy] = useState(false)
  const joined = me?.joined === true

  const change = async (join: boolean) => {
    setBusy(true)
    try {
      setMe(join ? await joinCommunity() : await leaveCommunity())
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : "Couldn't change that")
    } finally {
      setBusy(false)
    }
  }

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
          {joined && (
            <span className="truncate text-sm text-muted-foreground">Shown as @{me.login}</span>
          )}
        </span>
        <Switch
          id="community"
          checked={joined}
          disabled={busy || me === null}
          onCheckedChange={(checked) => void change(checked)}
        />
      </label>
      {joined ? (
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
