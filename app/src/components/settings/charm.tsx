/**
 * Settings → Charm: pair a Gots Charm, then send every bot to it, and decide whether one of them
 * lives there as a pet. The charm keeps them, with their pictures, after the phone has gone.
 * Android only, since only the app has the radio.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  BatteryMediumIcon,
  BellRingIcon,
  BluetoothIcon,
  CloudDownloadIcon,
  EyeIcon,
  EyeOffIcon,
  NetworkIcon,
  HandIcon,
  PawPrintIcon,
  RefreshCwIcon,
  UnlinkIcon,
  WifiIcon,
  WifiOffIcon,
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
  fieldInnerClass,
  fieldInputClass,
  fieldLabelClass,
  headerRowClass,
  rowClass,
} from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { botsByLabel, labelOf } from "@/lib/bot-name"
import {
  charmAvailable,
  charmBots,
  charmNetwork,
  charmPoses,
  charmUpdateStatus,
  forgetCharm,
  forgetCharmWifi,
  pairCharm,
  readCharmBattery,
  sendTestAlert,
  setCharmPet,
  setCharmTailnetKey,
  setCharmWifi,
  setCharmWake,
  syncToCharm,
  updateCharm,
  usePairedCharm,
} from "@/lib/charm"
import {
  CHARM_QUIET_PRESETS,
  CharmCode,
  CharmUpdateState,
  charmKept,
  charmWakeOf,
  codeWords,
  hexBytes,
  hexOf,
  petSettingsFrom,
  type CharmBatterySeen,
  type CharmNetworkReport,
  type CharmPetChoice,
  type CharmUpdateStatus,
  type CharmWake,
  type CharmWifiRecord,
} from "@/lib/charm-protocol"
import type { SyncProgress } from "@/lib/charm-sync"
import { listProfiles } from "@/lib/db"
import {
  batteryWords,
  charmSynced,
  doubleTapSubtitle,
  petSubtitle,
  QUIET_TITLE,
  quietWords,
  tailnetWords,
  updateWords,
  wifiWords,
} from "@/lib/charm-words"
import { quietly } from "@/lib/report"
import { tell } from "@/lib/tell"
import { useBotLabels } from "@/lib/use-bot-labels"

const message = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "Something went wrong"

/** How often a running firmware download is asked where it has got to. */
const UPDATE_POLL_MS = 2_000

/**
 * The Network section's radio, as the page reaches it: every call is one control ask over the
 * charm's own link. It is an interface so a test can draw the section's answers without a radio.
 */
export interface CharmNetworkApi {
  status(): Promise<CharmNetworkReport>
  saveWifi(ssid: string, pass: string): Promise<number>
  forget(): Promise<number>
  saveTailnet(key: string): Promise<number>
  update(url: string, sha256Hex: string): Promise<number>
  updateStatus(): Promise<CharmUpdateStatus>
}

/** The one implementation: the phone's own functions. */
const RADIO: CharmNetworkApi = {
  status: charmNetwork,
  saveWifi: setCharmWifi,
  forget: forgetCharmWifi,
  saveTailnet: setCharmTailnetKey,
  update: updateCharm,
  updateStatus: charmUpdateStatus,
}

/** One form's body in a group: the card's own fill, under the row that heads it. */
const formRowClass = "flex flex-col gap-4 bg-card px-5 py-4"

/** A labelled field of the network forms: the label above, the filled pill below. */
function Field({
  id,
  label,
  hint,
  ...input
}: { id: string; label: string; hint?: ReactNode } & Omit<
  ComponentProps<typeof Input>,
  "id" | "className"
>) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={fieldLabelClass}>
        {label}
      </label>
      <Input id={id} className={fieldInputClass} autoComplete="off" spellCheck={false} {...input} />
      {hint && <p className="px-1 text-xs break-all text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * A field whose value is a secret: masked, with the show toggle a key field wears, so a passphrase
 * can be read back while it is being typed and never again after the write.
 */
function SecretField({
  id,
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
}) {
  const [shown, setShown] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={fieldLabelClass}>
        {label}
      </label>
      <InputGroup className="h-12 rounded-full bg-muted">
        <InputGroupInput
          id={id}
          className={fieldInnerClass}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          type={shown ? "text" : "password"}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-sm"
            className="mr-1 size-10 rounded-full"
            aria-label={shown ? `Hide ${label}` : `Show ${label}`}
            onClick={() => setShown((open) => !open)}
          >
            {shown ? <EyeOffIcon /> : <EyeIcon />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

/**
 * Settings → Charm's network: the Wi-Fi the charm joins, the tailnet key it joins with, and a
 * firmware image it fetches itself. Every row draws the charm's own answer rather than what was
 * sent, and a passphrase or a key clears the moment the write has gone: neither is ever drawn
 * again, and neither is kept on this phone.
 */
export function CharmNetwork({
  api = RADIO,
  record,
  tailnet,
}: {
  /** The radio, or a stand-in under test. */
  api?: CharmNetworkApi
  /** The network this phone last told the charm to join, while the charm itself is not answering. */
  record?: CharmWifiRecord
  /** Whether a tailnet key was handed over before, while the charm itself is not answering. */
  tailnet?: boolean
}) {
  const [report, setReport] = useState<CharmNetworkReport | null>(null)
  const [update, setUpdate] = useState<CharmUpdateStatus | null>(null)
  const [ssid, setSsid] = useState("")
  const [pass, setPass] = useState("")
  const [key, setKey] = useState("")
  const [url, setUrl] = useState("")
  const [sha, setSha] = useState("")
  const [busy, setBusy] = useState<"wifi" | "forget" | "tailnet" | "update" | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [watching, setWatching] = useState(false)

  /** What the charm says about its links and its firmware, read in one go: both or neither. */
  const snapshot = useCallback(async () => {
    const [report, update] = await Promise.all([
      api.status().catch(() => null),
      api.updateStatus().catch(() => null),
    ])
    return { report, update }
  }, [api])

  // The section's first line is the charm's own: read once on opening, and again after each write.
  useEffect(() => {
    void snapshot().then(({ report, update }) => {
      if (report) setReport(report)
      if (update) setUpdate(update)
    })
  }, [snapshot])

  // A download that is running is asked where it has got to until it stops running.
  useEffect(() => {
    if (!watching) return
    let live = true
    const timer = setInterval(() => {
      void api
        .updateStatus()
        .then((next) => {
          if (!live) return
          setUpdate(next)
          if (next.state !== CharmUpdateState.Downloading) setWatching(false)
        })
        .catch(() => {
          if (live) setWatching(false)
        })
    }, UPDATE_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [watching, api])

  /** One write, its answer said in words: null while it is refused or never lands. */
  const write = async (what: typeof busy, run: () => Promise<number>): Promise<number | null> => {
    setBusy(what)
    setSaid(null)
    try {
      const code = await run()
      // A refusal gets the code's words. A plaintext charm's 11 is a yes whose words are the warning
      // that anyone holding the charm can read the secret off the chip, so it says them too.
      setSaid(code === CharmCode.Ok ? null : codeWords(code))
      if (charmKept(code)) {
        const { report: next, update: progress } = await snapshot()
        if (next) setReport(next)
        if (progress) setUpdate(progress)
      }
      return code
    } catch (error) {
      setSaid(message(error))
      return null
    } finally {
      setBusy(null)
    }
  }

  const saveWifi = async () => {
    const code = await write("wifi", () => api.saveWifi(ssid.trim(), pass))
    // The charm has the passphrase now, or refused it: either way this field never draws it again.
    if (code !== null) setPass("")
  }

  const forgetNetwork = async () => {
    const code = await write("forget", () => api.forget())
    if (code === CharmCode.Ok) setSsid("")
  }

  const saveKey = async () => {
    const code = await write("tailnet", () => api.saveTailnet(key.trim()))
    // The key is the charm's from here on, and is never drawn again.
    if (code !== null) setKey("")
  }

  const startUpdate = async () => {
    const code = await write("update", () => api.update(url.trim(), sha))
    if (code !== CharmCode.Ok) return
    setUpdate({ state: CharmUpdateState.Downloading, percent: 0, reason: 0 })
    setWatching(true)
  }

  // The hash as it will go over the wire, so a paste in capitals or with spaces is shown as it reads.
  const hash = (() => {
    try {
      return hexOf(hexBytes(sha))
    } catch {
      return ""
    }
  })()

  return (
    <>
      {said && <Caption>{said}</Caption>}
      <Group>
        <div className={headerRowClass}>
          <WifiIcon className="size-5 shrink-0 text-muted-foreground" />
          <RowText title="Wi-Fi" subtitle={wifiWords(report?.wifi, record)} />
        </div>
        <form
          className={formRowClass}
          onSubmit={(event) => {
            event.preventDefault()
            void saveWifi()
          }}
        >
          <Field
            id="charm-wifi-ssid"
            label="Network name"
            placeholder="Home"
            autoCapitalize="none"
            value={ssid}
            disabled={busy !== null}
            onChange={(event) => setSsid(event.target.value)}
          />
          <SecretField
            id="charm-wifi-pass"
            label="Passphrase"
            placeholder="Nothing, for an open network"
            value={pass}
            disabled={busy !== null}
            onChange={setPass}
          />
          <div className="flex items-center gap-2">
            <Button
              id="charm-wifi-save"
              type="submit"
              disabled={busy !== null || ssid.trim() === ""}
            >
              {busy === "wifi" ? "Saving…" : "Save"}
            </Button>
            <Button
              id="charm-wifi-forget"
              type="button"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void forgetNetwork()}
            >
              <WifiOffIcon />
              Forget
            </Button>
          </div>
        </form>
      </Group>
      <Group>
        <div className={headerRowClass}>
          <NetworkIcon className="size-5 shrink-0 text-muted-foreground" />
          <RowText title="Tailnet" subtitle={tailnetWords(report?.tailnet, tailnet)} />
        </div>
        <form
          className={formRowClass}
          onSubmit={(event) => {
            event.preventDefault()
            void saveKey()
          }}
        >
          <SecretField
            id="charm-tailnet-key"
            label="Auth key"
            placeholder="tskey-auth-…"
            value={key}
            disabled={busy !== null}
            onChange={setKey}
          />
          <div className="flex items-center gap-2">
            <Button
              id="charm-tailnet-save"
              type="submit"
              disabled={busy !== null || key.trim() === ""}
            >
              {busy === "tailnet" ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </Group>
      <Group>
        <div className={headerRowClass}>
          <CloudDownloadIcon className="size-5 shrink-0 text-muted-foreground" />
          <RowText title="Firmware" subtitle={updateWords(update)} />
        </div>
        <form
          className={formRowClass}
          onSubmit={(event) => {
            event.preventDefault()
            void startUpdate()
          }}
        >
          <Field
            id="charm-update-url"
            label="Image address"
            type="url"
            inputMode="url"
            placeholder="https://…"
            autoCapitalize="none"
            autoCorrect="off"
            value={url}
            disabled={busy !== null}
            onChange={(event) => setUrl(event.target.value)}
          />
          <Field
            id="charm-update-sha"
            label="SHA-256"
            placeholder="64 hexadecimal characters"
            autoCapitalize="none"
            autoCorrect="off"
            value={sha}
            disabled={busy !== null}
            onChange={(event) => setSha(event.target.value)}
            hint={
              sha.trim() === ""
                ? undefined
                : hash
                  ? `${hash.length / 2} of 32 bytes · ${hash}`
                  : "A SHA-256 is 64 hexadecimal characters"
            }
          />
          <div className="flex items-center gap-2">
            <Button
              id="charm-update-start"
              type="submit"
              disabled={busy !== null || url.trim() === "" || !hash}
            >
              {busy === "update" ? "Asking…" : "Update"}
            </Button>
          </div>
        </form>
      </Group>
      <Caption>
        The charm fetches the image itself, over https, and checks it against the SHA-256 before it
        writes it. A passphrase stays on the charm across a reboot: a charm whose flash isn't sealed
        says so, and warns that anyone holding it can read the passphrase off the chip.
      </Caption>
    </>
  )
}

export function CharmSettings() {
  const charm = usePairedCharm()
  const profiles = useLiveQuery(listProfiles, [])
  const labels = useBotLabels()
  const [busy, setBusy] = useState<"pair" | "sync" | "test" | "wake" | "battery" | null>(null)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [batteryNote, setBatteryNote] = useState<string | undefined>(undefined)
  const [forgetting, setForgetting] = useState(false)
  const [picking, setPicking] = useState(false)
  const sending = useRef(false)

  // The glass's own settings as this phone holds them, put back to the charm's defaults where the
  // stored copy says something it could not have chosen.
  const wake = charmWakeOf(charm?.wake)

  // A change goes at once, in its own connection: a switch that waited for the next sync would look
  // broken for as long as the reader does not sync. The phone's copy is written first, so the switch
  // stays where the reader put it even when the charm is out of reach.
  const applyWake = async (next: CharmWake) => {
    setBusy("wake")
    setFailure(null)
    try {
      await setCharmWake(next)
    } catch (error) {
      setFailure(message(error))
    } finally {
      setBusy(null)
    }
  }

  // A failed read is the row's own line, not the page's banner: the battery is the only thing that
  // row is about, and a charm whose firmware predates the op should say so where the level goes.
  const refreshBattery = async () => {
    if (!charm || sending.current) return
    sending.current = true
    setBusy("battery")
    try {
      await readCharmBattery()
      setBatteryNote(undefined)
    } catch (error) {
      setBatteryNote(message(error))
    } finally {
      sending.current = false
      setBusy(null)
    }
  }

  // One reading when the section opens: the charm is the only thing that knows its charge, and an
  // old reading is drawn with its age rather than pretended to be now. The row's tap asks again, and
  // a sync asks after it finishes.
  const deviceId = charm?.deviceId
  useEffect(() => {
    if (!deviceId) return
    void readCharmBattery()
      .then(() => setBatteryNote(undefined))
      .catch((error) => setBatteryNote(message(error)))
  }, [deviceId])

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
      // A sync just spent a connection and the charm is awake on the other end: the battery is
      // cheap to ask now, and the row is one sync fresher for it.
      await readCharmBattery().catch(quietly("reading the charm's battery"))
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
            <BatteryRow
              reading={charm.battery}
              note={batteryNote}
              busy={busy !== null}
              onRefresh={refreshBattery}
            />
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
          <WakingGroup wake={wake} busy={busy !== null} onChange={applyWake} />
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
          <CharmNetwork record={charm.wifi} tailnet={charm.tailnet} />
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

/**
 * The glass's own settings: whether two taps wake it, and how long it stays lit. Its own component
 * so a test can mount it with props and no radio, as the chrome's rows already are.
 */
export function WakingGroup({
  wake,
  busy,
  onChange,
}: {
  wake: CharmWake
  busy: boolean
  onChange: (wake: CharmWake) => void
}) {
  const [picking, setPicking] = useState(false)
  return (
    <>
      <Group>
        <SwitchRow
          id="charm-double-tap"
          icon={HandIcon}
          title="Double tap to wake"
          subtitle={doubleTapSubtitle(wake.doubleTap)}
          checked={wake.doubleTap}
          disabled={busy}
          onCheckedChange={(on) => onChange({ ...wake, doubleTap: on })}
        />
        <ValueRow
          title={QUIET_TITLE}
          purpose="After your last tap, flick or button"
          value={quietWords(wake.quietSeconds)}
          onClick={() => setPicking(true)}
          disabled={busy}
        />
      </Group>
      <PickSurface open={picking} onOpenChange={setPicking} title={QUIET_TITLE}>
        <PickList
          label="Quiet time"
          searchable={false}
          selected={String(wake.quietSeconds)}
          options={CHARM_QUIET_PRESETS.map((seconds) => ({
            id: String(seconds),
            label: quietWords(seconds),
          }))}
          onPick={(id) => {
            setPicking(false)
            const picked = CHARM_QUIET_PRESETS.find((seconds) => String(seconds) === id)
            if (picked && picked !== wake.quietSeconds) onChange({ ...wake, quietSeconds: picked })
          }}
        />
      </PickSurface>
    </>
  )
}

/**
 * What the charm last said its charge was. Tapping it asks again, because the reading is the charm's
 * and this row only remembers it.
 */
export function BatteryRow({
  reading,
  note,
  busy,
  onRefresh,
}: {
  reading?: CharmBatterySeen
  note?: string
  busy: boolean
  onRefresh: () => void
}) {
  return (
    <button type="button" className={rowClass} onClick={onRefresh} disabled={busy}>
      <BatteryMediumIcon className="size-5 shrink-0 text-muted-foreground" />
      <RowText title="Battery" subtitle={note ?? batteryWords(reading)} />
    </button>
  )
}
