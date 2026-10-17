import { useCallback, useEffect, useState, type ReactNode } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useNavigate } from "react-router"
import { FingerprintIcon, LogInIcon, TrophyIcon } from "lucide-react"
import { toast } from "sonner"

import { RecoveryCode, UnlockSync } from "@/components/account-settings"
import { Bot } from "@/components/bot"
import { SharingNotes } from "@/components/community-settings"
import { LinkBots } from "@/components/link-bots"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { signIn } from "@/lib/account"
import { joinCommunity, leaveCommunity, useCommunity } from "@/lib/community"
import { db, getActiveProfile, getSettings, saveSettings } from "@/lib/db"
import {
  addPasskey,
  needsBotSetup,
  setUpSync,
  syncNow,
  useSyncState,
  type SyncState,
} from "@/lib/sync"
import { supportsPasskeys } from "@/lib/vault"
import { cn } from "@/lib/utils"

type Step = "sign-in" | "sync" | "community" | "checking" | "link"

function isAuthed({ account, vault }: SyncState) {
  return (
    account.status === "unavailable" || (account.status === "signed-in" && vault === "unlocked")
  )
}

/**
 * Keeps the app behind sign-in and unlocked sync wherever the deploy has Identity, and behind
 * linking a bot until there's one.
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const sync = useSyncState()
  const onboarded = useLiveQuery(async () => (await getSettings()).onboarded ?? null, [])
  const noBots = useLiveQuery(needsBotSetup, [])
  // Signing out clears it, so a data key here means this device was set up and unlocked before.
  const unlockedBefore = useLiveQuery(async () => Boolean(await db.vault.get("key")), [])
  // Held here so the dialog outlives the wizard if unlocking is all this device needed.
  const [recoveryCode, setRecoveryCode] = useState<string>()

  const { account } = sync
  const waiting =
    account.status === "loading" ||
    onboarded === undefined ||
    noBots === undefined ||
    (account.status === "signed-in" && sync.vault === "unknown" && !sync.error)
  // A returning device opens at once rather than after Identity and the vault answer; if they then
  // say it's signed out or locked, setup takes over.
  if (waiting) {
    return unlockedBefore && onboarded && !noBots ? (
      children
    ) : (
      <div className="h-dvh bg-background" />
    )
  }
  // Without Identity nothing can link, so the seed bot is set up by hand in Settings instead.
  const linking = account.status !== "unavailable" && noBots
  if (isAuthed(sync) && onboarded && !linking && !recoveryCode) return children
  return <SetupPage recoveryCode={recoveryCode} setRecoveryCode={setRecoveryCode} />
}

/** First-run setup: sign in, unlock sync, join the leaderboard, then link a bot from its Hermes host. */
function SetupPage({
  recoveryCode,
  setRecoveryCode,
}: {
  recoveryCode?: string
  setRecoveryCode: (code?: string) => void
}) {
  const sync = useSyncState()
  const navigate = useNavigate()
  const profile = useLiveQuery(getActiveProfile, [])
  const [linkStep, setLinkStep] = useState<"checking" | "community" | "link">("checking")
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [reachable, setReachable] = useState(false)
  const onReachable = useCallback((ok: boolean) => setReachable(ok), [])

  const { account } = sync
  const identity = account.status !== "unavailable"
  const authed = isAuthed(sync)
  const step: Step =
    account.status === "signed-out" ? "sign-in" : !authed || recoveryCode ? "sync" : linkStep

  // Once in, a returning user's bots arrive through sync and there's nothing left to set up.
  useEffect(() => {
    if (!authed || recoveryCode) return
    let cancelled = false
    void (async () => {
      await syncNow()
      if (cancelled) return
      if (!identity) return void (await saveSettings({ onboarded: true }))
      const { onboarded } = await getSettings()
      if (onboarded === undefined) await saveSettings({ onboarded: !(await needsBotSetup()) })
      if (!cancelled) setLinkStep("community")
    })()
    return () => {
      cancelled = true
    }
  }, [authed, recoveryCode, identity])

  const fail = (error: unknown) =>
    toast.error(error instanceof Error ? error.message : "Something went wrong.")

  const turnOn = async () => {
    setBusy(true)
    try {
      setRecoveryCode((await setUpSync()).recoveryCode)
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const addPasskeyToo = async () => {
    setBusy(true)
    try {
      await addPasskey()
      toast.success("Passkey added")
    } catch (error) {
      // Cancelling the prompt is a choice, not a failure: the code is already the way in.
      if (!(error instanceof DOMException && error.name === "NotAllowedError")) fail(error)
    } finally {
      setBusy(false)
    }
  }

  const finish = async () => {
    await saveSettings({ onboarded: true })
    navigate("/", { replace: true })
  }

  const steps: Step[] = ["sign-in", "sync", "community", "link"]

  return (
    <div className="flex h-dvh flex-col overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 pt-[max(3rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
        <div className="flex flex-col items-center gap-4 text-center">
          <Bot id={profile?.botId} animate className="size-20" />
          {step !== "checking" && <StepDots steps={steps} current={step} />}
        </div>

        {step === "sign-in" && (
          <Section title="Welcome to Gots" description="Sign in to get started.">
            <Button size="lg" className="h-11 self-center" onClick={signIn}>
              <LogInIcon data-icon="inline-start" />
              Sign in with GitHub
            </Button>
          </Section>
        )}

        {step === "sync" && recoveryCode && (
          <Section
            title="Your recovery code"
            description="Save it. It's the only way back into your chats on a new device."
          >
            <RecoveryCode code={recoveryCode} onCopied={() => setCopied(true)} />
            {supportsPasskeys() && (
              <Button
                variant="outline"
                size="lg"
                className="h-11"
                disabled={busy}
                onClick={addPasskeyToo}
              >
                <FingerprintIcon data-icon="inline-start" />
                Add a passkey too
              </Button>
            )}
            <Button
              size="lg"
              className="h-11"
              disabled={!copied}
              onClick={() => setRecoveryCode(undefined)}
            >
              Continue
            </Button>
          </Section>
        )}

        {step === "sync" && !recoveryCode && (
          <Section
            title={sync.vault === "locked" ? "Unlock sync" : "Turn on sync"}
            description="Your bots, API keys and chat titles are encrypted on this device before they're stored."
          >
            {sync.vault === "unknown" && !sync.error && <Spinner className="self-center" />}
            {sync.vault === "missing" && (
              <Button size="lg" className="h-11 self-center" disabled={busy} onClick={turnOn}>
                <FingerprintIcon data-icon="inline-start" />
                Turn on sync
              </Button>
            )}
            {sync.vault === "locked" && (
              <div className="flex flex-col gap-3">
                <UnlockSync />
              </div>
            )}
            {sync.error && (
              <p className="text-sm text-destructive" role="alert">
                {sync.error}
              </p>
            )}
          </Section>
        )}

        {step === "checking" && <Spinner className="self-center" />}

        {step === "community" && <CommunityStep onDone={() => setLinkStep("link")} />}

        {step === "link" && (
          <Section title="Link your bots">
            <LinkBots onReachable={onReachable} />
            <Button size="lg" className="h-11" disabled={!reachable} onClick={finish}>
              Start chatting
            </Button>
          </Section>
        )}
      </div>
    </div>
  )
}

/**
 * Joining the leaderboard is on by default, so a new user is counted unless they turn it off here.
 * Settings > Community can still leave it later.
 */
function CommunityStep({ onDone }: { onDone: () => void }) {
  const { me, setMe } = useCommunity()
  const [on, setOn] = useState(true)
  const [busy, setBusy] = useState(false)
  const joined = me?.joined === true

  const next = async () => {
    setBusy(true)
    try {
      // A read that failed leaves nothing to compare, so the choice is sent as it stands.
      if (me !== undefined && on !== joined) {
        setMe(on ? await joinCommunity() : await leaveCommunity())
      }
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : "Couldn't change that. You can change it in Settings.",
      )
    } finally {
      setBusy(false)
    }
    onDone()
  }

  return (
    <Section
      title="Join the leaderboard"
      description="Climb the public board with your token counts."
    >
      <label
        htmlFor="community-setup"
        className="flex min-h-14 cursor-pointer items-center gap-4 rounded-3xl bg-card px-5 py-3 text-card-foreground ring-1 ring-foreground/10"
      >
        <TrophyIcon className="size-5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-base">Join the leaderboard</span>
          {joined && me.login && (
            <span className="truncate text-sm text-muted-foreground">Shown as @{me.login}</span>
          )}
        </span>
        <Switch
          id="community-setup"
          checked={on}
          disabled={busy}
          onCheckedChange={(checked) => setOn(checked)}
        />
      </label>
      <SharingNotes />
      <Button size="lg" className="h-11" disabled={busy} onClick={next}>
        Continue
      </Button>
    </Section>
  )
}

function StepDots({ steps, current }: { steps: Step[]; current: Step }) {
  const index = steps.indexOf(current)
  return (
    <ol className="flex gap-2" aria-label={`Step ${index + 1} of ${steps.length}`}>
      {steps.map((step, i) => (
        <li
          key={step}
          className={cn(
            "h-1.5 w-6 rounded-full bg-muted transition-colors",
            i <= index && "bg-primary",
          )}
        />
      ))}
    </ol>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-5">
      <div className="space-y-1.5 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  )
}
