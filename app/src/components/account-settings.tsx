import { Fragment, useEffect, useRef, useState } from "react"
import {
  CheckIcon,
  CopyIcon,
  FingerprintIcon,
  KeyIcon,
  LogInIcon,
  LogOutIcon,
  RefreshCwIcon,
} from "lucide-react"
import { toast } from "sonner"

import { useCopiedCode } from "@/components/copied-code"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { signIn } from "@/lib/account"
import { formatRelative } from "@/lib/format"
import {
  addPasskey,
  canAddPasskey,
  canRotateRecoveryCode,
  rotateRecoveryCode,
  setUpSync,
  signOut,
  type PendingSetup,
  syncNow,
  unlockSyncWithPasskey,
  unlockSyncWithRecoveryCode,
  useSyncState,
} from "@/lib/sync"
import { supportsPasskeys } from "@/lib/vault"

function message(error: unknown) {
  if (error instanceof DOMException && error.name === "NotAllowedError") return "Passkey cancelled."
  return error instanceof Error ? error.message : "Something went wrong."
}

/** GitHub sign-in and end-to-end encrypted sync of bots and the chat list. */
export function AccountSettings() {
  const sync = useSyncState()
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PendingSetup>()
  const [rotation, setRotation] = useState<{ code: string; confirm: () => Promise<void> }>()
  const [asking, setAsking] = useState(false)

  const { account } = sync
  if (account.status === "loading" || account.status === "unavailable") return null

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      toast.error(message(error))
    } finally {
      setBusy(false)
    }
  }

  const rotate = () =>
    canRotateRecoveryCode()
      ? void run(async () => setRotation(await rotateRecoveryCode()))
      : setAsking(true)

  return (
    <Card className="rounded-3xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">Sync</CardTitle>
        <CardDescription>
          Bots, API keys and chat titles are encrypted on your device before they're stored on the
          server.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {account.status === "signed-out" ? (
          <Button onClick={signIn}>
            <LogInIcon data-icon="inline-start" />
            Sign in with GitHub
          </Button>
        ) : (
          <FieldGroup>
            <div className="flex items-center gap-3">
              {account.user.pictureUrl && (
                <img
                  src={account.user.pictureUrl}
                  alt=""
                  className="size-10 shrink-0 rounded-full ring-1 ring-foreground/10"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {account.user.name ?? account.user.email}
                </p>
                {account.user.name && account.user.email && (
                  <p className="truncate text-sm text-muted-foreground">{account.user.email}</p>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon-lg"
                className="size-11 shrink-0 rounded-full"
                aria-label="Sign out"
                title="Sign out"
                onClick={() => run(signOut)}
              >
                <LogOutIcon />
              </Button>
            </div>

            {sync.vault === "unknown" && !sync.error && <Spinner />}

            {sync.vault === "missing" && (
              <Button
                className="self-start"
                disabled={busy}
                onClick={() => run(async () => setPending(await setUpSync()))}
              >
                <FingerprintIcon data-icon="inline-start" />
                Turn on sync
              </Button>
            )}

            {sync.vault === "locked" && <UnlockSync />}

            {sync.error && (
              <p className="text-sm text-destructive" role="alert">
                {sync.error}
              </p>
            )}

            {sync.vault === "unlocked" && (
              <div className="flex flex-col gap-3">
                <LastSynced at={sync.syncedAt} />
                <div className="flex flex-wrap gap-3">
                  <Button variant="outline" disabled={sync.syncing} onClick={() => void syncNow()}>
                    <RefreshCwIcon data-icon="inline-start" />
                    Sync now
                  </Button>
                  {supportsPasskeys() && canAddPasskey() && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await addPasskey()
                          toast.success("Passkey added")
                        })
                      }
                    >
                      <FingerprintIcon data-icon="inline-start" />
                      Add passkey
                    </Button>
                  )}
                  <Button variant="outline" disabled={busy} onClick={rotate}>
                    <KeyIcon data-icon="inline-start" />
                    New recovery code
                  </Button>
                </div>
              </div>
            )}
          </FieldGroup>
        )}
      </CardContent>

      <RecoveryCodeDialog
        code={pending?.recoveryCode}
        onDone={() => {
          const setup = pending
          setPending(undefined)
          run(async () => setup?.confirm())
        }}
      />
      <RotationDialog
        open={asking || Boolean(rotation)}
        code={rotation?.code}
        busy={busy}
        onCancel={() => setAsking(false)}
        onCurrentCode={(code) =>
          void run(async () => {
            setRotation(await rotateRecoveryCode(code))
            setAsking(false)
          })
        }
        onDone={() => {
          const confirm = rotation?.confirm
          setRotation(undefined)
          if (confirm) void confirm().catch((error) => toast.error(message(error)))
        }}
      />
    </Card>
  )
}

/** Unlocks sync on this device with a passkey or the recovery code. */
export function UnlockSync() {
  const sync = useSyncState()
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState("")

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      toast.error(message(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {sync.passkeys && supportsPasskeys() && (
        <Button className="self-start" disabled={busy} onClick={() => run(unlockSyncWithPasskey)}>
          <FingerprintIcon data-icon="inline-start" />
          Unlock with passkey
        </Button>
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void run(async () => {
            await unlockSyncWithRecoveryCode(code)
            setCode("")
          })
        }}
      >
        <Field>
          <FieldLabel htmlFor="recovery-code">Recovery code</FieldLabel>
          <Input
            id="recovery-code"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
            className="font-mono"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <Button
          type="submit"
          variant="outline"
          className="self-start"
          disabled={busy || !code.trim()}
        >
          Unlock
        </Button>
      </form>
    </>
  )
}

/** A recovery code with the copy button that marks it handled. */
export function RecoveryCode({
  code,
  copied,
  onCopied,
}: {
  code: string
  copied: boolean
  onCopied?: () => void
}) {
  const text = useRef<HTMLElement>(null)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
    } catch {
      // A browser that refuses the clipboard still gets the code selected to copy by hand.
      const range = document.createRange()
      if (text.current) range.selectNodeContents(text.current)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
    onCopied?.()
  }
  const groups = code.split("-")
  return (
    <div className="flex items-center gap-1 rounded-2xl bg-muted py-3 pr-1 pl-3">
      {/* Centred, so a code too wide for the box is two tidy lines rather than one broken one. Each
          hyphen carries a break opportunity of its own: the browser won't offer one at "…-7…" (a
          hyphen before a digit is not a break in its eyes), so without a `wbr` a code runs under the
          button instead of wrapping. */}
      <code ref={text} className="min-w-0 flex-1 text-center font-mono text-sm select-all">
        {groups.map((group, index) => (
          <Fragment key={index}>
            {group}
            {index < groups.length - 1 && (
              <>
                -
                <wbr />
              </>
            )}
          </Fragment>
        ))}
      </code>
      <Button
        variant="ghost"
        size="icon-lg"
        className="size-11 shrink-0"
        aria-label="Copy recovery code"
        onClick={copy}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  )
}

/** The code as a card of its own: shown, held until it's been copied, and the button that goes on. */
function RecoveryCodeStep({
  code,
  title,
  action,
  onDone,
}: {
  code: string
  title: string
  action: string
  onDone: () => void
}) {
  const { copied, noteCopied } = useCopiedCode(code)
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>
          Save it. It's the only way back into your chats on a new device.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <RecoveryCode code={code} copied={copied} onCopied={noteCopied} />
      <AlertDialogFooter>
        <AlertDialogAction disabled={!copied} onClick={onDone}>
          {action}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  )
}

/** Asks for the code that can still open the account, before a new one replaces it. */
function AskForCode({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean
  onSubmit: (code: string) => void
  onCancel: () => void
}) {
  // The field goes with the step: showing the code unmounts it, so the next round starts empty
  // rather than holding the code that was just retired.
  const [current, setCurrent] = useState("")
  return (
    <form
      className="grid gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(current)
      }}
    >
      <AlertDialogHeader>
        <AlertDialogTitle>Enter your current recovery code</AlertDialogTitle>
      </AlertDialogHeader>
      <Input
        aria-label="Current recovery code"
        autoFocus
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
        className="font-mono"
        value={current}
        onChange={(event) => setCurrent(event.target.value)}
      />
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy} onClick={onCancel}>
          Cancel
        </AlertDialogCancel>
        <AlertDialogAction type="submit" disabled={busy || !current.trim()}>
          Continue
        </AlertDialogAction>
      </AlertDialogFooter>
    </form>
  )
}

/**
 * Replacing a recovery code: one dialog for both steps, first asking for the code that can still open
 * the account, then showing the new one and waiting for it to be copied. A form in an AlertDialog is
 * the exception here, recorded in `docs/adr/0005-a-recovery-code-is-compulsory-a-passkey-is-optional.md`:
 * the two steps are one card, and the code the second step shows is the answer to the first.
 */
function RotationDialog({
  open,
  code,
  busy,
  onCancel,
  onCurrentCode,
  onDone,
}: {
  open: boolean
  code?: string
  busy: boolean
  onCancel: () => void
  onCurrentCode: (code: string) => void
  onDone: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={(open) => !open && onCancel()}>
      {/* The dialog's own width is a phone's, which a code overflows: take what the screen gives. */}
      <AlertDialogContent className="data-[size=default]:max-w-[calc(100%-1.5rem)]">
        {code ? (
          <RecoveryCodeStep
            code={code}
            title="Your new recovery code"
            action="Use this code"
            onDone={onDone}
          />
        ) : (
          <AskForCode busy={busy} onSubmit={onCurrentCode} onCancel={onCancel} />
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** The code a vault this device is turning on waits on, shown over the card that asked for it. */
export function RecoveryCodeDialog({
  code,
  title = "Your recovery code",
  action = "I've saved it",
  onDone,
}: {
  code?: string
  title?: string
  action?: string
  onDone: () => void
}) {
  return (
    <AlertDialog open={Boolean(code)}>
      <AlertDialogContent>
        <RecoveryCodeStep code={code ?? ""} title={title} action={action} onDone={onDone} />
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** "Last synced 5 min. ago", kept fresh while the card is open. */
function LastSynced({ at }: { at?: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  if (!at) return <p className="text-sm text-muted-foreground">Not synced yet</p>
  const when = Math.max(now, at) - at < 60_000 ? "just now" : formatRelative(at, Math.max(now, at))
  return (
    <p className="text-sm text-muted-foreground">
      Last synced{" "}
      <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
        {when}
      </time>
    </p>
  )
}
