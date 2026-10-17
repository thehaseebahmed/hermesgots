import { useEffect, useRef, useState } from "react"
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

import {
  AlertDialog,
  AlertDialogAction,
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
  const [recoveryCode, setRecoveryCode] = useState<string>()
  const [rotation, setRotation] = useState<{ code: string; confirm: () => Promise<void> }>()
  const [verifying, setVerifying] = useState(false)
  const [currentCode, setCurrentCode] = useState("")

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

  const rotate = (code?: string) => run(async () => setRotation(await rotateRecoveryCode(code)))

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
                onClick={() =>
                  run(async () => {
                    const result = await setUpSync()
                    setRecoveryCode(result.recoveryCode)
                  })
                }
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
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => (canRotateRecoveryCode() ? void rotate() : setVerifying(true))}
                  >
                    <KeyIcon data-icon="inline-start" />
                    New recovery code
                  </Button>
                </div>
              </div>
            )}
          </FieldGroup>
        )}
      </CardContent>

      <RecoveryCodeDialog code={recoveryCode} onDone={() => setRecoveryCode(undefined)} />
      <RecoveryCodeDialog
        code={rotation?.code}
        title="Your new recovery code"
        description="Save this code — the one you had stops working once you confirm."
        action="Use this code"
        onDone={() => {
          const confirm = rotation?.confirm
          setRotation(undefined)
          if (confirm) void confirm().catch((error) => toast.error(message(error)))
        }}
      />
      <AlertDialog open={verifying} onOpenChange={setVerifying}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enter your current recovery code</AlertDialogTitle>
            <AlertDialogDescription>
              This device can't unwrap sync by itself, so it needs the code you already have.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              run(async () => {
                setRotation(await rotateRecoveryCode(currentCode))
                setVerifying(false)
                setCurrentCode("")
              })
            }}
          >
            <Input
              aria-label="Current recovery code"
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
              className="font-mono"
              value={currentCode}
              onChange={(event) => setCurrentCode(event.target.value)}
            />
            <AlertDialogFooter>
              <Button type="submit" disabled={busy || !currentCode.trim()}>
                Continue
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
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
export function RecoveryCode({ code, onCopied }: { code: string; onCopied?: () => void }) {
  // Which code was copied, so a new one starts unhandled without an effect.
  const [copiedCode, setCopiedCode] = useState<string>()
  const copied = copiedCode === code
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
    setCopiedCode(code)
    onCopied?.()
  }
  return (
    <div className="flex items-center gap-2 rounded-2xl bg-muted p-3">
      <code ref={text} className="min-w-0 flex-1 font-mono text-sm select-all">
        {code}
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

/**
 * Shows a freshly made recovery code and won't close until it's been copied: the code is the only
 * way back into sync without a passkey, so skipping it silently loses an account's recovery.
 */
export function RecoveryCodeDialog({
  code,
  title = "Your recovery code",
  description = "Save it. It's the only way back into your chats on a new device.",
  action = "I've saved it",
  onDone,
}: {
  code?: string
  title?: string
  description?: string
  action?: string
  onDone: () => void
}) {
  const [copiedCode, setCopiedCode] = useState<string>()
  const copied = Boolean(code) && copiedCode === code
  return (
    <AlertDialog open={Boolean(code)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <RecoveryCode code={code ?? ""} onCopied={() => setCopiedCode(code)} />
        <AlertDialogFooter>
          <AlertDialogAction disabled={!copied} onClick={onDone}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
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
