import { useEffect, useState, type ReactNode } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useNavigate } from "react-router"
import { CheckIcon, CopyIcon, FingerprintIcon, LogInIcon } from "lucide-react"
import { toast } from "sonner"

import { RecoveryCodeDialog, UnlockSync } from "@/components/account-settings"
import { Bot } from "@/components/bot"
import { BotEditor } from "@/components/bot-settings"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { signIn } from "@/lib/account"
import { getActiveProfile, getSettings, saveSettings, updateProfile } from "@/lib/db"
import { needsBotSetup, setUpSync, syncNow, useSyncState, type SyncState } from "@/lib/sync"
import { cn } from "@/lib/utils"

type Step = "sign-in" | "sync" | "checking" | "server" | "bot"

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function isAuthed({ account, vault }: SyncState) {
  return (
    account.status === "unavailable" || (account.status === "signed-in" && vault === "unlocked")
  )
}

/**
 * Keeps the app behind sign-in and unlocked sync wherever the deploy has Identity, and behind
 * first-run setup until it's done.
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const sync = useSyncState()
  const onboarded = useLiveQuery(async () => (await getSettings()).onboarded ?? null, [])
  // Held here so the dialog outlives the wizard if unlocking is all this device needed.
  const [recoveryCode, setRecoveryCode] = useState<string>()

  const { account } = sync
  const waiting =
    account.status === "loading" ||
    onboarded === undefined ||
    (account.status === "signed-in" && sync.vault === "unknown" && !sync.error)
  if (waiting) return <div className="h-dvh bg-background" />
  if (isAuthed(sync) && onboarded && !recoveryCode) return children
  return <SetupPage recoveryCode={recoveryCode} setRecoveryCode={setRecoveryCode} />
}

/** First-run setup: sign in and unlock sync (where the deploy has Identity), then connect Hermes. */
function SetupPage({
  recoveryCode,
  setRecoveryCode,
}: {
  recoveryCode?: string
  setRecoveryCode: (code?: string) => void
}) {
  const sync = useSyncState()
  const navigate = useNavigate()
  const [hermesStep, setHermesStep] = useState<"checking" | "server" | "bot">("checking")
  const [busy, setBusy] = useState(false)
  const profile = useLiveQuery(getActiveProfile, [])

  const { account } = sync
  const identity = account.status !== "unavailable"
  const authed = isAuthed(sync)
  const step: Step =
    account.status === "signed-out" ? "sign-in" : !authed || recoveryCode ? "sync" : hermesStep

  // Once in, a returning user's bots arrive through sync and there's nothing left to set up.
  useEffect(() => {
    if (!authed || recoveryCode) return
    let cancelled = false
    void (async () => {
      await syncNow()
      const { onboarded } = await getSettings()
      if (cancelled || onboarded) return
      if (onboarded === undefined) {
        await saveSettings({ onboarded: !(await needsBotSetup()) })
        if (cancelled) return
      }
      setHermesStep((current) => (current === "checking" ? "server" : current))
    })()
    return () => {
      cancelled = true
    }
  }, [authed, recoveryCode])

  const finish = async () => {
    await saveSettings({ onboarded: true })
    navigate("/", { replace: true })
  }

  const steps: Step[] = identity ? ["sign-in", "sync", "server", "bot"] : ["server", "bot"]

  return (
    <div className="flex h-dvh flex-col overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 pt-[max(3rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
        <div className="flex flex-col items-center gap-4 text-center">
          <Bot id={profile?.botId} animate className="size-20" />
          {step !== "checking" && <StepDots steps={steps} current={step} />}
        </div>

        {step === "sign-in" && (
          <Section title="Welcome to Memento" description="Sign in to get started.">
            <Button size="lg" className="h-11 self-center" onClick={signIn}>
              <LogInIcon data-icon="inline-start" />
              Sign in with GitHub
            </Button>
          </Section>
        )}

        {step === "sync" && (
          <Section
            title={sync.vault === "locked" ? "Unlock sync" : "Turn on sync"}
            description="Your bots, API keys and chat titles are encrypted on this device before they're stored."
          >
            {sync.vault === "unknown" && !sync.error && <Spinner className="self-center" />}
            {sync.vault === "missing" && (
              <Button
                size="lg"
                className="h-11 self-center"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    setRecoveryCode((await setUpSync()).recoveryCode)
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : "Something went wrong.")
                  } finally {
                    setBusy(false)
                  }
                }}
              >
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

        {step === "server" && <ServerStep onNext={() => setHermesStep("bot")} />}

        {step === "bot" && <BotStep onBack={() => setHermesStep("server")} onDone={finish} />}
      </div>

      <RecoveryCodeDialog code={recoveryCode} onDone={() => setRecoveryCode(undefined)} />
    </div>
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

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-start gap-2 rounded-2xl bg-muted p-3">
      <pre className="min-w-0 flex-1 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap select-all">
        {text}
      </pre>
      <Button
        variant="ghost"
        size="icon-lg"
        className="-my-1.5 size-11 shrink-0"
        aria-label={label}
        onClick={async () => {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  )
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>
}

/** How to turn on Hermes's API server, from its `.env` file or the Hermes Dashboard. */
function ServerStep({ onNext }: { onNext: () => void }) {
  const profile = useLiveQuery(getActiveProfile, [])
  const [method, setMethod] = useState<"env" | "dashboard">("env")

  // The key the instructions hand out is the one the bot will use.
  useEffect(() => {
    if (profile && !profile.apiKey) void updateProfile(profile.id, { apiKey: randomKey() })
  }, [profile])

  if (!profile?.apiKey) return <Spinner className="self-center" />
  const origin = window.location.origin
  const cors = `API_SERVER_CORS_ORIGINS=${origin}`

  return (
    <Section title="Turn on the API server" description="Memento talks to Hermes through it.">
      <ToggleGroup
        variant="outline"
        className="w-full"
        value={[method]}
        onValueChange={(value) => value[0] && setMethod(value[0] as "env" | "dashboard")}
      >
        <ToggleGroupItem value="env" className="h-11 flex-1">
          .env file
        </ToggleGroupItem>
        <ToggleGroupItem value="dashboard" className="h-11 flex-1">
          Hermes Dashboard
        </ToggleGroupItem>
      </ToggleGroup>

      {method === "env" ? (
        <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm marker:text-muted-foreground">
          <li className="space-y-2">
            <p>
              Add these lines to <Code>~/.hermes/.env</Code>:
            </p>
            <CopyBlock
              label="Copy .env lines"
              text={`API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${profile.apiKey}\n${cors}`}
            />
          </li>
          <li className="space-y-2">
            <p>Restart the gateway:</p>
            <CopyBlock label="Copy restart command" text="hermes gateway restart" />
          </li>
        </ol>
      ) : (
        <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm marker:text-muted-foreground">
          <li className="space-y-2">
            <p>
              Run <Code>hermes dashboard</Code> and open <Code>http://127.0.0.1:9119</Code>.
            </p>
          </li>
          <li className="space-y-2">
            <p>
              Go to <strong>Channels</strong>, find <strong>API server</strong> and choose{" "}
              <strong>Configure</strong>. Set <strong>Enable API server</strong> to{" "}
              <Code>true</Code> and the auth key to:
            </p>
            <CopyBlock label="Copy API key" text={profile.apiKey} />
          </li>
          <li className="space-y-2">
            <p>
              The dashboard has no CORS setting, so add this line to <Code>~/.hermes/.env</Code>:
            </p>
            <CopyBlock label="Copy CORS line" text={cors} />
          </li>
          <li>
            <p>
              Turn the API server on and choose <strong>Restart gateway</strong>.
            </p>
          </li>
        </ol>
      )}

      <p className="text-sm text-muted-foreground">
        For a named profile, use <Code>~/.hermes/profiles/&lt;name&gt;/.env</Code> instead.
      </p>

      <Button size="lg" className="h-11" onClick={onNext}>
        Next
      </Button>
    </Section>
  )
}

function BotStep({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const profile = useLiveQuery(getActiveProfile, [])
  const [connected, setConnected] = useState(false)
  if (!profile) return <Spinner className="self-center" />

  return (
    <Section title="Connect your bot" description="Point it at your Hermes API server.">
      <BotEditor profile={profile} setup onConnected={() => setConnected(true)} />
      <div className="flex flex-col gap-2">
        <Button size="lg" className="h-11" disabled={!connected} onClick={onDone}>
          Start chatting
        </Button>
        <div className="flex justify-between">
          <Button variant="ghost" className="h-11" onClick={onBack}>
            Back
          </Button>
          <Button variant="ghost" className="h-11" onClick={onDone}>
            Skip for now
          </Button>
        </div>
      </div>
    </Section>
  )
}
