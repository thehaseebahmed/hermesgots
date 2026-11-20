/**
 * Settings → Charm: pair a Gots Charm, then send every bot to it. The charm keeps them, with
 * their pictures, after the phone has gone. Android only, since only the app has the radio.
 */
import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { BluetoothIcon, RefreshCwIcon, UnlinkIcon } from "lucide-react"

import { Banner } from "@/components/banner"
import { ConfirmDestructive } from "@/components/confirm-destructive"
import { ActionRow, Caption, Group, RowText, rowClass } from "@/components/settings-chrome"
import { botsByLabel } from "@/lib/bot-name"
import {
  charmAvailable,
  charmBots,
  forgetCharm,
  pairCharm,
  syncToCharm,
  usePairedCharm,
} from "@/lib/charm"
import type { SyncProgress } from "@/lib/charm-sync"
import { listProfiles } from "@/lib/db"
import { charmSubtitle } from "@/lib/charm-words"
import { tell } from "@/lib/tell"
import { useBotLabels } from "@/lib/use-bot-labels"

const message = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "Something went wrong"

export function CharmSettings() {
  const charm = usePairedCharm()
  const profiles = useLiveQuery(listProfiles, [])
  const labels = useBotLabels()
  const [busy, setBusy] = useState<"pair" | "sync" | null>(null)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [forgetting, setForgetting] = useState(false)

  if (!charmAvailable())
    return (
      <Banner tone="info">
        A Gots Charm pairs with the Android app over Bluetooth. Open Gots on your phone to set one
        up.
      </Banner>
    )

  const pair = async () => {
    setBusy("pair")
    setFailure(null)
    try {
      const next = await pairCharm()
      tell.success(`Paired with ${next.name}`)
    } catch (error) {
      // Closing the picker is a choice, not a failure.
      if (!/cancel/i.test(message(error))) setFailure(message(error))
    } finally {
      setBusy(null)
    }
  }

  const sync = async () => {
    setBusy("sync")
    setFailure(null)
    setProgress(null)
    try {
      const bots = await charmBots(botsByLabel(profiles ?? [], labels), labels)
      const done = await syncToCharm(bots, setProgress)
      tell.success(done.total === 1 ? "1 bot on your charm" : `${done.total} bots on your charm`)
    } catch (error) {
      setFailure(message(error))
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  const count = (profiles ?? []).filter((p) => !p.disabled).length

  return (
    <>
      {failure && <Banner tone="error">{failure}</Banner>}
      {charm ? (
        <>
          <Group>
            <div className={rowClass}>
              <BluetoothIcon className="size-5 shrink-0 text-muted-foreground" />
              <RowText title={charm.name} subtitle={charmSubtitle(charm)} />
            </div>
            <button
              type="button"
              className={rowClass}
              onClick={sync}
              disabled={busy !== null || count === 0}
            >
              <RefreshCwIcon
                className={`size-5 shrink-0 text-muted-foreground ${busy === "sync" ? "animate-spin" : ""}`}
              />
              <RowText
                title={busy === "sync" ? "Syncing…" : "Sync"}
                subtitle={
                  progress
                    ? `${progress.done} of ${progress.total} bots`
                    : count === 0
                      ? "No bots to send"
                      : `Sends your ${count === 1 ? "bot" : `${count} bots`} and their pictures`
                }
              />
            </button>
          </Group>
          <Group>
            <ActionRow
              icon={UnlinkIcon}
              title="Forget this charm"
              onClick={() => setForgetting(true)}
            />
          </Group>
          <Caption>
            Keep the charm close while it syncs. Afterwards it shows your bots on its own, with the
            phone away. It holds names and pictures only, never keys or server addresses.
          </Caption>
          <ConfirmDestructive
            open={forgetting}
            onOpenChange={setForgetting}
            title="Forget this charm?"
            description="This phone stops syncing to it. The charm keeps the bots it has. To pair again, remove it from Android's Bluetooth settings too."
            confirmLabel="Forget"
            onConfirm={async () => {
              forgetCharm()
              tell.success("Charm forgotten")
            }}
          />
        </>
      ) : (
        <>
          <Group>
            <button type="button" className={rowClass} onClick={pair} disabled={busy !== null}>
              <BluetoothIcon className="size-5 shrink-0 text-muted-foreground" />
              <RowText
                title={busy === "pair" ? "Pairing…" : "Pair a charm"}
                subtitle="Turn the charm on and keep it close"
              />
            </button>
          </Group>
          <Caption>
            Pick “Gots Charm”, then type the six-digit code it shows. You only pair once.
          </Caption>
        </>
      )}
    </>
  )
}
