/**
 * Settings → Charm: pair a Gots Charm, then send every bot to it, and decide whether one of them
 * lives there as a pet. The charm keeps them, with their pictures, after the phone has gone.
 * Android only, since only the app has the radio.
 */
import { useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  BellRingIcon,
  BluetoothIcon,
  PawPrintIcon,
  RefreshCwIcon,
  UnlinkIcon,
} from "lucide-react"

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
  sendTestAlert,
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
  const [busy, setBusy] = useState<"pair" | "sync" | "test" | null>(null)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [forgetting, setForgetting] = useState(false)
  const [picking, setPicking] = useState(false)
  const sending = useRef(false)

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

  // The charm's own order, so the picker lists bots as the carousel does.
  const sources = botsByLabel(profiles ?? [], labels).filter((p) => !p.disabled)
  const pet = charm?.pet
  const petProfile = sources.find((p) => p.id === pet?.botId)
  const petName = petProfile ? labelOf(labels, petProfile) : undefined

  // `choice` is what the sheet has just written, for the sends that follow a tap: the store the
  // charm is read from re-renders after this call, not before it.
  const sync = async (choice?: CharmPetChoice) => {
    // `busy` is a render behind, so two taps in one tick would both reach the radio.
    if (sending.current || !profiles) return
    sending.current = true
    setBusy("sync")
    setFailure(null)
    setProgress(null)
    try {
      const bots = await charmBots(sources, labels)
      const settings = petSettingsFrom(
        choice ?? pet,
        sources.map((p) => p.id),
      )
      // Pictures are the character's, so the pet's are drawn from its profile's botId.
      const petBot = sources.find((p) => p.id === settings.petBotId)
      const poses = settings.enabled && petBot ? await charmPoses(petBot.botId) : []
      const done = await syncToCharm(bots, setProgress, { pet: { settings, poses } })
      tell.success(done.total === 1 ? "1 bot on your charm" : `${done.total} bots on your charm`)
      if (done.petRefused && settings.enabled)
        tell.info("Your bots synced. This charm's firmware has no pet mode yet.")
    } catch (error) {
      setFailure(message(error))
    } finally {
      sending.current = false
      setBusy(null)
      setProgress(null)
    }
  }

  const applyPet = async (choice: CharmPetChoice) => {
    setCharmPet(choice)
    await sync(choice)
  }

  const choosePet = async (botId: string) => {
    setPicking(false)
    await applyPet({ enabled: true, botId })
  }

  // A bare tap on with no pet picked takes the first bot; a pet whose bot has gone is not one.
  const togglePet = async (on: boolean) => {
    const botId =
      petSettingsFrom(
        pet,
        sources.map((p) => p.id),
      ).petBotId || sources[0]?.id
    if (on && !botId) {
      setFailure("Add a bot first: the pet is one of your bots.")
      return
    }
    await applyPet({ enabled: on, botId })
  }

  const count = sources.length

  // The first bot the charm holds, which is the one a test alert names: the same order a sync sends.
  const first = botsByLabel(profiles ?? [], labels).filter((profile) => !profile.disabled)[0]

  const test = async () => {
    if (!first) return
    setBusy("test")
    setFailure(null)
    try {
      await sendTestAlert(first)
      tell.success("Sent a test alert")
    } catch (error) {
      setFailure(message(error))
    } finally {
      setBusy(null)
    }
  }

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
              checked={Boolean(pet?.enabled && petProfile)}
              disabled={busy !== null || !profiles}
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
            <button
              type="button"
              className={rowClass}
              onClick={test}
              disabled={busy !== null || !first}
            >
              <BellRingIcon className="size-5 shrink-0 text-muted-foreground" />
              <RowText
                title={busy === "test" ? "Sending…" : "Send a test alert"}
                subtitle={
                  first
                    ? "Buzzes your charm as if your first bot needed an approval"
                    : "No bots on your charm to test with"
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
