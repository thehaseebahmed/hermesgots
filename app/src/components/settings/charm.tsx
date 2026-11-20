/**
 * Settings → Charm: pair a Gots Charm, then send every bot to it, and decide whether one of them
 * lives there as a pet. The charm keeps them, with their pictures, after the phone has gone.
 * Android only, since only the app has the radio.
 */
import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { BluetoothIcon, PawPrintIcon, RefreshCwIcon, UnlinkIcon } from "lucide-react"

import { Banner } from "@/components/banner"
import { ConfirmDestructive } from "@/components/confirm-destructive"
import {
  ActionRow,
  Caption,
  Group,
  PickList,
  PickSurface,
  RowText,
  SwitchRow,
  ValueRow,
  rowClass,
} from "@/components/settings-chrome"
import { botsByLabel, labelOf } from "@/lib/bot-name"
import {
  charmAvailable,
  charmBots,
  charmPoses,
  forgetCharm,
  pairCharm,
  setCharmPet,
  syncToCharm,
  usePairedCharm,
} from "@/lib/charm"
import { petSettingsFrom, type CharmPetChoice } from "@/lib/charm-protocol"
import type { SyncProgress } from "@/lib/charm-sync"
import { listProfiles } from "@/lib/db"
import { charmSynced, petSubtitle } from "@/lib/charm-words"
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
  const [picking, setPicking] = useState(false)

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

  const sources = (profiles ?? []).filter((p) => !p.disabled)
  const pet = charm?.pet
  const petProfile = sources.find((p) => p.id === pet?.botId)
  const petName = petProfile ? labelOf(labels, petProfile) : undefined

  // `choice` is what the sheet has just written, for the sends that follow a tap: the store the
  // charm is read from re-renders after this call, not before it.
  const sync = async (choice?: CharmPetChoice) => {
    setBusy("sync")
    setFailure(null)
    setProgress(null)
    try {
      const bots = await charmBots(botsByLabel(profiles ?? [], labels), labels)
      const settings = petSettingsFrom(
        choice ?? pet,
        sources.map((p) => p.id),
      )
      // The pet's pictures come from its character, and only one of them is the pet.
      const petBot = sources.find((p) => p.id === settings.petBotId)
      const poses = settings.enabled && petBot ? await charmPoses(petBot.botId) : []
      const done = await syncToCharm(bots, setProgress, { pet: { settings, poses } })
      tell.success(done.total === 1 ? "1 bot on your charm" : `${done.total} bots on your charm`)
    } catch (error) {
      setFailure(message(error))
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  const choosePet = async (botId: string) => {
    setPicking(false)
    const choice = { enabled: true, botId }
    setCharmPet(choice)
    await sync(choice)
  }

  /** Off to on needs a bot to be the pet; the first one is a sensible answer to a bare tap. */
  const togglePet = async (on: boolean) => {
    const botId = pet?.botId ?? sources[0]?.id
    if (on && !botId) {
      setFailure("Add a bot first: the pet is one of your bots.")
      return
    }
    const choice = { enabled: on, botId }
    setCharmPet(choice)
    await sync(choice)
  }

  const count = sources.length

  return (
    <>
      {failure && <Banner tone="error">{failure}</Banner>}
      {charm ? (
        <>
          <Group>
            <div className={rowClass}>
              <BluetoothIcon className="size-5 shrink-0 text-muted-foreground" />
              <RowText title={charm.name} subtitle={charmSynced(charm)} />
            </div>
            <button
              type="button"
              className={rowClass}
              onClick={() => sync()}
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
                      : count === 1
                        ? "Sends your bot and its picture"
                        : `Sends your ${count} bots and their pictures`
                }
              />
            </button>
          </Group>
          <Group>
            <SwitchRow
              id="charm-pet-mode"
              icon={PawPrintIcon}
              title="Pet mode"
              subtitle={petSubtitle(pet, petName)}
              checked={Boolean(pet?.enabled)}
              disabled={busy !== null}
              onCheckedChange={togglePet}
            />
            {pet?.enabled && (
              <ValueRow
                title="The pet"
                purpose="Feed it and play with it on the charm"
                value={petName}
                muted={!petName}
                onClick={() => setPicking(true)}
                disabled={busy !== null}
              />
            )}
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
          <PickSurface open={picking} onOpenChange={setPicking} title="The pet">
            <PickList
              label="Your bots"
              searchable={false}
              selected={pet?.botId}
              options={sources.map((profile) => ({
                id: profile.id,
                label: labelOf(labels, profile),
              }))}
              onPick={choosePet}
            />
          </PickSurface>
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
