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
import { useNavigate } from "react-router"
import {
  BatteryMediumIcon,
  BellRingIcon,
  CloudDownloadIcon,
  EyeIcon,
  EyeOffIcon,
  FileUpIcon,
  HandIcon,
  MicIcon,
  PawPrintIcon,
  RefreshCwIcon,
  UnlinkIcon,
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
  charmFirmwareVersion,
  charmNetwork,
  charmPoses,
  charmUpdateStatus,
  forgetCharm,
  forgetCharmWifi,
  pairCharm,
  PUBLISHED_FIRMWARE,
  charmVoice,
  readCharmBattery,
  readCharmTalk,
  recordCharmTalk,
  sendTestAlert,
  setCharmPet,
  setCharmTailnetKey,
  setCharmVoice,
  setCharmWake,
  setCharmWifi,
  syncToCharm,
  useCharmReport,
  usePairedCharm,
  type CharmScheme,
  type PairedCharm,
} from "@/lib/charm"
import {
  CHARM_QUIET_PRESETS,
  CharmCode,
  CharmUpdateState,
  charmKept,
  charmWakeOf,
  codeWords,
  petSettingsFrom,
  type CharmBatterySeen,
  type CharmNetworkReport,
  type CharmPetChoice,
  type CharmUpdateStatus,
  type CharmWake,
  type CharmWifiRecord,
} from "@/lib/charm-protocol"
import type { SyncProgress } from "@/lib/charm-sync"
import { serverConfig } from "@/lib/connection"
import { getActiveProfile, listProfiles, type Profile } from "@/lib/db"
import type { PluginServer } from "@/lib/features"
import { CHARM_POLL_MS } from "@/lib/freshness"
import { getTalkAddress, getTalkToken } from "@/lib/hermes"
import { useHostRecord } from "@/lib/host-record"
import {
  BATTERY_ASK,
  batteryWords,
  doubleTapSubtitle,
  FIRMWARE_CAPTION,
  firmwareOffers,
  firmwareWords,
  LINK_DOWN_WORDS,
  LINK_MARKS,
  linksDown,
  petSubtitle,
  QUIET_TITLE,
  quietWords,
  readFailed,
  readValue,
  tailnetWords,
  updateWords,
  VOICE_HTTP,
  VOICE_HTTPS,
  VOICE_HELD_ASKING,
  VOICE_HELD_NONE,
  VOICE_HELD_PURPOSE,
  VOICE_HELD_TITLE,
  VOICE_HELD_UNKNOWN,
  VOICE_NO_TAILNET,
  wifiWords,
  type CharmLink,
  type CharmRead,
  type CharmRunning,
  type CharmSeen,
} from "@/lib/charm-words"
import { quietly } from "@/lib/report"
import { spoken } from "@/lib/words"
import { talkWords, voiceAddress, voiceOwed } from "@/lib/talk"
import { tell } from "@/lib/tell"
import { useBotLabels } from "@/lib/use-bot-labels"

/**
 * The Network section's radio, as the page reaches it: every call is one control ask over the
 * charm's own link. It is an interface so a test can draw the section's answers without a radio.
 * What the host says about the published firmware is not the charm's answer, and is not here: it is
 * that host's own record, read by the row below. The upload is not here either — it is the update
 * screen's, which is where the whole send now runs.
 */
export interface CharmNetworkApi {
  status(): Promise<CharmNetworkReport>
  saveWifi(ssid: string, pass: string): Promise<number>
  forget(): Promise<number>
  saveTailnet(key: string): Promise<number>
  updateStatus(): Promise<CharmUpdateStatus>
  /** Which build the charm runs; null for a firmware too old to have the ask. */
  version(): Promise<string | null>
}

/** The one implementation: the phone's own functions. */
const RADIO: CharmNetworkApi = {
  status: charmNetwork,
  saveWifi: setCharmWifi,
  forget: forgetCharmWifi,
  saveTailnet: setCharmTailnetKey,
  updateStatus: charmUpdateStatus,
  version: charmFirmwareVersion,
}

/**
 * What the Firmware row is drawn from: the build the charm says it runs, the package's own record of
 * what its host publishes, and where this charm's download has got to. The row draws these rather
 * than reading them, so the page can move it without a second read following it to its new place.
 */
export interface CharmFirmwareFacts {
  /** The charm's own answer about the build it runs. */
  running: CharmRunning
  /** The version the host publishes, where it answered with one. */
  published?: string
  /** Whether the host's read is over: nothing published is its refusal, not a wait. */
  answered: boolean
  /** The host's own sentence where its read was refused, or null where it answered. */
  checkSaid: string | null
  /** The charm's download, as it last answered. */
  update: CharmRead<CharmUpdateStatus>
  /** The download asked again, since a write the charm kept may have moved it. */
  read: () => Promise<CharmUpdateStatus | undefined>
}

/**
 * The firmware's four facts, read in one place: the page reads them, and the row it draws them in
 * asks nothing of the charm. A poll in each of two rows would put two asks on one link, so only one
 * instance of this ever asks — a section handed the facts passes `null` and leaves the asking to
 * whichever component read them.
 */
function useCharmFirmware(
  /** The radio to ask, or null where the facts were handed in and nothing is to be asked. */
  api: Pick<CharmNetworkApi, "updateStatus" | "version"> | null,
  /** The bot whose host publishes the firmware: the row's read of it is that host's record. */
  profile: PluginServer,
): CharmFirmwareFacts {
  const [update, setUpdate] = useState<CharmRead<CharmUpdateStatus>>({ state: "reading" })
  /** Which build the charm runs, as its own answer says. */
  const [running, setRunning] = useState<CharmRunning>({ state: "reading" })
  const [watching, setWatching] = useState(false)
  /**
   * What the host says `latest` holds, as one of its own records: read when the row opens, kept for
   * its next open, and read again when a merge may have moved the tag. A plugin older than the route
   * answers nothing, and the row says it couldn't check.
   */
  const firmware = useHostRecord(api ? profile : undefined, PUBLISHED_FIRMWARE, undefined)
  const seen = firmware.value
  const published = seen?.state === "published" ? seen.firmware : undefined

  /**
   * Where the charm's download has got to, asked when the row opens and again after each write. A
   * failed ask keeps what an earlier one found — the charm is out of reach, not empty — and says why,
   * since refused, disconnected and timed out are three facts rather than one silence.
   */
  const read = useCallback(
    () =>
      api
        ? api.updateStatus().then(
            (value) => {
              setUpdate({ state: "read", value })
              return value
            },
            (reason: unknown) => {
              quietly("reading the charm's download")(reason)
              setUpdate(readFailed)
              return undefined
            },
          )
        : Promise.resolve(undefined),
    [api],
  )

  /**
   * The charm's own version when the row opens: a version it can't say stays unsaid rather than
   * guessed, and a link that never opened is its own fact. What the package publishes is the host's
   * record above, read alongside it.
   */
  useEffect(() => {
    if (!api) return
    void api.version().then(
      (found) =>
        setRunning(found === null ? { state: "too-old" } : { state: "says", version: found }),
      () => setRunning({ state: "unreachable" }),
    )
  }, [api])

  // The download's own line: read once on opening, and again after each write.
  useEffect(() => {
    if (!api) return
    void read().then((found) => {
      // A download already running when the row opens is followed to its end, as one it started was.
      if (found?.state === CharmUpdateState.Downloading) setWatching(true)
    })
  }, [api, read])

  // A download that is running is asked where it has got to until it stops running.
  useEffect(() => {
    if (!api || !watching) return
    const radio = api
    let live = true
    const timer = setInterval(() => {
      void radio
        .updateStatus()
        .then((next) => {
          if (!live) return
          setUpdate({ state: "read", value: next })
          if (next.state !== CharmUpdateState.Downloading) setWatching(false)
        })
        .catch(() => {
          if (!live) return
          // The charm stopped answering: the poll ends, and what it last said is still what it said.
          setUpdate((before) => readFailed(before))
          setWatching(false)
        })
    }, CHARM_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [watching, api])

  return {
    running,
    published: published?.version,
    answered: firmware.settled,
    checkSaid: seen?.state === "refused" ? seen.said : null,
    update,
    read,
  }
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
 * A link's own mark at a row's size: the pair row and both link headers wear the one map the status
 * row wears, so a link cannot be a globe here and the charm's waypoints two rows down.
 */
function LinkIcon({ link }: { link: CharmLink }) {
  const Mark = LINK_MARKS[link]
  return <Mark className="size-5 shrink-0 text-muted-foreground" />
}

/**
 * The Firmware group: the build the charm says it runs beside the one the package publishes, and the
 * two doors onto the update's own screen. It reads nothing — the facts are the page's, handed in —
 * so the row can be drawn anywhere on the page without a read following it there.
 */
export function FirmwareGroup({
  facts,
  busy,
  onUpdate,
  onPick,
}: {
  facts: CharmFirmwareFacts
  /** Whether the page is busy with something else: neither door opens under another send. */
  busy: boolean
  /** The update's own screen, where the send runs. */
  onUpdate: () => void
  /** The same screen, ready for a picked file. */
  onPick: () => void
}) {
  const { running, published, answered } = facts
  /** The two versions the row compares: the charm's own, and the package's as its host reads it. */
  const versions = { running, published, answered }
  const offers = firmwareOffers(versions)
  const downloading = readValue(facts.update)
  return (
    <>
      <Group>
        <div className={headerRowClass}>
          <CloudDownloadIcon className="size-5 shrink-0 text-muted-foreground" />
          <RowText title="Firmware" subtitle={firmwareWords(versions)} />
        </div>
        <div className={formRowClass}>
          <div className="flex flex-wrap items-center gap-2">
            {offers && published && (
              <Button id="charm-update-start" type="button" disabled={busy} onClick={onUpdate}>
                Update to {published}
              </Button>
            )}
            <Button
              id="charm-update-pick"
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={onPick}
            >
              <FileUpIcon />
              Choose a file…
            </Button>
          </div>
        </div>
      </Group>
      {facts.checkSaid && <Caption>{facts.checkSaid}</Caption>}
      <Caption>{FIRMWARE_CAPTION}</Caption>
      {downloading && downloading.state !== CharmUpdateState.Idle && (
        <Caption>{updateWords(downloading)}</Caption>
      )}
    </>
  )
}

/**
 * Settings → Charm's network: the Wi-Fi the charm joins, the tailnet key it joins with, and the
 * firmware it runs — the version it says it has beside the one the package publishes, and the two
 * doors onto the update's own screen: an update when the published one is newer, a file otherwise.
 * Every row draws the charm's own answer rather than what was sent, and a passphrase or a key clears
 * the moment the write has gone: neither is ever drawn again, and neither is kept on this phone.
 *
 * The firmware's facts are the page's, handed in, so the row can move out of this section without a
 * second read following it; drawn alone — as a test draws it — the section reads them itself.
 */
export function CharmNetwork({
  api = RADIO,
  profile,
  record,
  tailnet,
  read,
  refresh,
  firmware,
}: {
  /** The radio, or a stand-in under test. */
  api?: CharmNetworkApi
  /** The bot whose host publishes the firmware: the row's read of it is that host's record. */
  profile?: PluginServer
  /** The network this phone last told the charm to join, while the charm itself is not answering. */
  record?: CharmWifiRecord
  /** Whether a tailnet key was handed over before, while the charm itself is not answering. */
  tailnet?: boolean
  /**
   * The page's own read of the charm's links, made above this section: the same one the status row
   * draws, so the two rows cannot disagree about what the charm said.
   */
  read: CharmRead<CharmNetworkReport>
  /** Asks the charm's links again after a write: the section never makes that ask itself. */
  refresh: () => Promise<void>
  /**
   * The firmware's facts, where the page read them: handed in, this section asks the charm nothing
   * about its firmware, and the page's one poll is the only one on the link.
   */
  firmware?: CharmFirmwareFacts
}) {
  // Nothing is asked here where the page handed the facts down: two rows with a poll of their own
  // would put two asks on one link.
  const own = useCharmFirmware(firmware ? null : api, profile)
  const facts = firmware ?? own
  const [ssid, setSsid] = useState("")
  const [pass, setPass] = useState("")
  const [key, setKey] = useState("")
  const [busy, setBusy] = useState<"wifi" | "forget" | "tailnet" | null>(null)
  const [said, setSaid] = useState<string | null>(null)

  /** What the charm last answered about its two links. */
  const links = readValue(read)

  /** One write, its answer said in words: null while it is refused or never lands. */
  const write = async (what: typeof busy, run: () => Promise<number>): Promise<number | null> => {
    setBusy(what)
    setSaid(null)
    try {
      const code = await run()
      // A refusal gets the code's words. A plaintext charm's 11 is a yes whose words are the warning
      // that anyone holding the charm can read the secret off the chip, so it says them too.
      setSaid(code === CharmCode.Ok ? null : codeWords(code))
      // A write the charm kept is read back: its links and its download, from the same asks as before.
      if (charmKept(code)) await Promise.all([refresh(), facts.read()])
      return code
    } catch (error) {
      setSaid(spoken(error, "Something went wrong"))
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

  /**
   * The Firmware row's two doors onto the update's own screen, which is where the send runs now:
   * the steps, the bars, the version read back and the failure's words all live there, and leaving
   * this section is what stops the status poll below — the upload holds the charm's link alone.
   */
  const navigate = useNavigate()

  return (
    <>
      {said && <Caption>{said}</Caption>}
      <Group>
        <div className={headerRowClass}>
          <LinkIcon link="wifi" />
          <RowText title="Wi-Fi" subtitle={wifiWords(links?.wifi, record)} />
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
          <LinkIcon link="tailnet" />
          <RowText title="Tailnet" subtitle={tailnetWords(links?.tailnet, tailnet)} />
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
      <FirmwareGroup
        facts={facts}
        busy={busy !== null}
        onUpdate={() => navigate("/settings/charm-firmware")}
        onPick={() => navigate("/settings/charm-firmware?file=1")}
      />
      <Caption>
        The image goes over the charm's own link, and the charm checks it against the SHA-256 it was
        given before it keeps it. A passphrase stays on the charm across a reboot: a charm whose
        flash isn't sealed says so, and warns that anyone holding it can read the passphrase off the
        chip.
      </Caption>
    </>
  )
}

/**
 * The scheme the charm reaches its host by: https over the charm's own Wi-Fi with a certificate
 * checked against the roots the firmware ships, or plain http over the tailnet. The reader's choice
 * and nothing else: this touches no radio, it is kept on this phone's record of the charm, and the
 * next sync is what hands the address it picks to the charm.
 */
export function CharmVoiceScheme({
  scheme,
  disabled,
  onChange,
}: {
  scheme: CharmScheme
  disabled?: boolean
  onChange: (scheme: CharmScheme) => void
}) {
  const https = scheme === "https"
  return (
    <SwitchRow
      id="charm-voice-https"
      icon={MicIcon}
      title="Voice over https"
      subtitle={https ? VOICE_HTTPS : VOICE_HTTP}
      checked={https}
      disabled={Boolean(disabled)}
      onCheckedChange={(on) => onChange(on ? "https" : "http")}
    />
  )
}

/**
 * What the charm itself says it holds, drawn under the switch: its own answer rather than this
 * phone's record, so a hand-over that failed and one that never ran are the charm's word and not a
 * guess. A firmware older than the ask cannot answer at all, and the row says that instead.
 */
export function CharmVoiceHeld({
  address,
  failed,
}: {
  /** The charm's answer, or undefined while it is being asked. */
  address?: string | null
  /** The ask itself did not land: no radio, or a firmware that has no such op. */
  failed?: boolean
}) {
  const value = failed
    ? VOICE_HELD_UNKNOWN
    : address === undefined
      ? VOICE_HELD_ASKING
      : (address ?? VOICE_HELD_NONE)
  return (
    <ValueRow
      title={VOICE_HELD_TITLE}
      purpose={VOICE_HELD_PURPOSE}
      value={value}
      muted={Boolean(failed) || !address}
      disabled
    />
  )
}

/**
 * The paired section's first row: its name with a mark for each link that is down, and its level as
 * the line beneath — the row's subtitle, as every row in this page's groups keeps its value. Its own
 * component so a test can draw it with props and no radio, as the battery row and the waking group
 * already are. The level is drawn always, unlike the glass's, because a settings page has no band to
 * pull — and a mark is drawn only for a link the page has read and found down, since a mark for a
 * fact nobody has read would be a guess.
 */
export function CharmStatusRow({
  charm,
  status,
  battery,
}: {
  charm: CharmSeen
  /** The page's own read of the charm's link, and the last report it answered with. */
  status: CharmRead<CharmNetworkReport>
  /** What the charm last said its charge was. */
  battery?: CharmBatterySeen
}) {
  return (
    <div className={rowClass}>
      <RowText
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{charm.name}</span>
            {linksDown(status).map((link) => {
              const Mark = LINK_MARKS[link]
              return (
                <Mark
                  key={link}
                  role="img"
                  aria-label={LINK_DOWN_WORDS[link]}
                  className="size-4 shrink-0 text-muted-foreground"
                />
              )
            })}
          </span>
        }
        subtitle={batteryWords(battery)}
      />
    </div>
  )
}

/** What the page is busy with while it is busy: one send at a time, so a second tap never reaches the radio. */
export type CharmBusy = "pair" | "sync" | "test" | "wake" | "battery" | null

/**
 * The Sync row: sends every bot and its picture, and says how far it has got while it does. Its own
 * component so the sections draw it from props, with the tap the page's to run.
 */
export function SyncRow({
  count,
  busy,
  syncing,
  progress,
  onSync,
}: {
  /** How many bots the charm can be sent. */
  count: number
  /** Whether the page is busy with anything: a send under way is never doubled. */
  busy: boolean
  /** Whether this row's own send is the one running. */
  syncing: boolean
  /** How far the running send has got. */
  progress: SyncProgress | null
  onSync: () => void
}) {
  return (
    <button type="button" className={rowClass} onClick={onSync} disabled={busy || count === 0}>
      <RefreshCwIcon
        className={`size-5 shrink-0 text-muted-foreground ${syncing ? "animate-spin" : ""}`}
      />
      <RowText
        title={syncing ? "Syncing…" : "Sync"}
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
  )
}

/**
 * The test alert's row: buzzes the charm as the first bot would, so the reader sees the card it draws
 * before a real one needs them. Its own component for the same reason as the Sync row.
 */
export function TestAlertRow({
  canSend,
  busy,
  sending,
  onSend,
}: {
  /** Whether there is a bot to draw an alert for. */
  canSend: boolean
  busy: boolean
  /** Whether this row's own send is the one running. */
  sending: boolean
  onSend: () => void
}) {
  return (
    <button type="button" className={rowClass} onClick={onSend} disabled={busy || !canSend}>
      <BellRingIcon className="size-5 shrink-0 text-muted-foreground" />
      <RowText
        title={sending ? "Sending…" : "Send a test alert"}
        subtitle={
          canSend
            ? "Buzzes your charm as if your first bot needed an approval"
            : "No bots on your charm to test with"
        }
      />
    </button>
  )
}

/**
 * The paired page, drawn from facts alone: the charm and its charge, the bots and the pet, the wake
 * settings, the voice, the page's own read of the links, and the firmware's four facts. Nothing here
 * reads Dexie or the radio and no effect asks the charm, so a test can mount the whole page with
 * fixtures — and the firmware's row can be drawn above the network section with no read of its own
 * following it there.
 */
export function CharmSections({
  charm,
  report,
  firmware,
  sources,
  botsRead,
  labels,
  busy,
  progress,
  failure,
  batteryNote,
  wake,
  scheme,
  held,
  heldFailed,
  onSync,
  onTest,
  onTogglePet,
  onPickPet,
  onWake,
  onScheme,
  onBattery,
  onForget,
}: {
  /** The paired charm, as this phone's record holds it. */
  charm: PairedCharm
  /** The page's own read of the charm's links, and the ask that reads them again after a write. */
  report: { read: CharmRead<CharmNetworkReport>; refresh: () => Promise<void> }
  /** The firmware's four facts, read by the page above this. */
  firmware: CharmFirmwareFacts
  /** Every bot the charm can be sent, in the picker's own order. */
  sources: Profile[]
  /** Whether this phone's list of bots has been read: a switch moved before it has nothing to pick. */
  botsRead: boolean
  /** What this phone calls each bot, labelled against every other one. */
  labels: Map<string, string>
  busy: CharmBusy
  /** How far the running send has got, or null while none runs. */
  progress: SyncProgress | null
  /** What went wrong, in words: the page's banner while it stands. */
  failure: string | null
  /** Why the last battery ask failed, in the row's own line. */
  batteryNote?: string
  wake: CharmWake
  scheme: CharmScheme
  /** What the charm says it holds, and whether the ask itself landed: `undefined` is "being asked". */
  held: string | null | undefined
  heldFailed: boolean
  onSync: () => void
  onTest: () => void
  onTogglePet: (on: boolean) => void
  /** Opens the sheet the pet is picked from: the page holds it, beside the sections. */
  onPickPet: () => void
  onWake: (wake: CharmWake) => void
  onScheme: (scheme: CharmScheme) => void
  onBattery: () => void
  onForget: () => void
}) {
  const pet = charm.pet
  /** The bot that lives on the charm, where one does, and what this phone calls it. */
  const petProfile = sources.find((profile) => profile.id === pet?.botId)
  const petName = petProfile ? labelOf(labels, petProfile) : undefined
  return (
    <>
      {failure && <Banner tone="error">{failure}</Banner>}
      <Group>
        <CharmStatusRow charm={charm} status={report.read} battery={charm.battery} />
        <BatteryRow note={batteryNote} busy={busy !== null} onRefresh={onBattery} />
        <SyncRow
          count={sources.length}
          busy={busy !== null}
          syncing={busy === "sync"}
          progress={progress}
          onSync={onSync}
        />
        <CharmVoiceScheme scheme={scheme} disabled={busy !== null} onChange={onScheme} />
        <CharmVoiceHeld address={held} failed={heldFailed} />
      </Group>
      <WakingGroup wake={wake} busy={busy !== null} onChange={onWake} />
      <Group>
        <SwitchRow
          id="charm-pet-mode"
          icon={PawPrintIcon}
          title="Pet mode"
          subtitle={petSubtitle(pet, petName)}
          checked={Boolean(pet?.enabled && petProfile)}
          disabled={busy !== null || !botsRead}
          onCheckedChange={onTogglePet}
        />
        {pet?.enabled && (
          <ValueRow
            title="The pet"
            purpose="Feed it and play with it on the charm"
            value={petName}
            muted={!petName}
            onClick={onPickPet}
            disabled={busy !== null}
          />
        )}
        <TestAlertRow
          canSend={sources.length > 0}
          busy={busy !== null}
          sending={busy === "test"}
          onSend={onTest}
        />
      </Group>
      <CharmNetwork
        firmware={firmware}
        record={charm.wifi}
        tailnet={charm.tailnet}
        read={report.read}
        refresh={report.refresh}
      />
      <Group>
        <ActionRow icon={UnlinkIcon} title="Forget this charm" onClick={onForget} />
      </Group>
      <Caption>
        Keep the charm close while it syncs. Afterwards it shows your bots on its own, with the
        phone away. It holds names and pictures, and — once voice is set up — the address it calls
        and its own token. Nothing else leaves the phone, and the token is kept nowhere else.
      </Caption>
    </>
  )
}

/**
 * Settings → Charm's shell: the gate, the phone's own reads, and the handlers a tap calls. The page
 * below it is drawn from what they hold, so the sections can be mounted with fixtures, and the
 * firmware's facts are read once here — wherever on the page the row drawing them ends up.
 */
export function CharmSettings() {
  const charm = usePairedCharm()
  const profiles = useLiveQuery(listProfiles, [])
  /** The bot whose host publishes the firmware: the row's own read of it is that host's record. */
  const profile = useLiveQuery(getActiveProfile, [])
  const labels = useBotLabels()
  const [busy, setBusy] = useState<CharmBusy>(null)
  /** The page's own read of the charm's links: the status row and the Network section both draw it. */
  const report = useCharmReport()
  /**
   * The firmware's facts, read here rather than beside the row that draws them: one poll on the
   * charm's link, and a row moved to the Device group takes its facts with it and asks nothing.
   */
  const firmware = useCharmFirmware(charm ? RADIO : null, profile)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [batteryNote, setBatteryNote] = useState<string | undefined>(undefined)
  /** What the charm says it holds, and whether the ask itself landed: `undefined` is "being asked". */
  const [held, setHeld] = useState<string | null | undefined>(undefined)
  const [heldFailed, setHeldFailed] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  const [picking, setPicking] = useState(false)
  const sending = useRef(false)

  // The glass's own settings as this phone holds them, put back to the charm's defaults where the
  // stored copy says something it could not have chosen.
  const wake = charmWakeOf(charm?.wake)
  // Which scheme the next sync hands the charm: the reader's, kept on the record, https unless they
  // moved it.
  const scheme = charmVoice(charm)

  // A change goes at once, in its own connection: a switch that waited for the next sync would look
  // broken for as long as the reader does not sync. The phone's copy is written first, so the switch
  // stays where the reader put it even when the charm is out of reach.
  const applyWake = async (next: CharmWake) => {
    setBusy("wake")
    setFailure(null)
    try {
      await setCharmWake(next)
    } catch (error) {
      setFailure(spoken(error, "Something went wrong"))
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
      setBatteryNote(spoken(error, "Something went wrong"))
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
      .catch((error) => setBatteryNote(spoken(error, "Something went wrong")))
  }, [deviceId])

  // The charm's own answer about its voice, read when the page opens and again after a sync.
  const readVoice = useCallback(async () => {
    try {
      setHeld(await readCharmTalk())
      setHeldFailed(false)
    } catch {
      setHeldFailed(true)
    }
  }, [])
  useEffect(() => {
    if (!deviceId) return
    void readVoice()
  }, [deviceId, readVoice])

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
      if (!/cancel/i.test(spoken(error, "Something went wrong"))) setFailure(spoken(error, "Something went wrong"))
    } finally {
      setBusy(null)
    }
  }

  // The charm's own order, so the picker lists bots as the carousel does.
  const sources = botsByLabel(profiles ?? [], labels).filter((p) => !p.disabled)
  const pet = charm?.pet

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
      // The voice hand-over, when the host's own answer says this charm holds another address, another
      // bot's token, or nothing at all. Asked without a token, because a mint revokes the one the charm
      // holds; the mint itself runs at the frame's write, deep in the sync.
      let talk: { address: string; bot: string; mint: () => Promise<string> } | undefined
      let voiceNote: string | undefined
      if (profile) {
        try {
          const addresses = await getTalkAddress(serverConfig(profile))
          const address = voiceAddress(addresses, scheme)
          if (address && voiceOwed(charm, address, addresses.bot, held)) {
            talk = {
              address,
              bot: addresses.bot,
              mint: async () => (await getTalkToken(serverConfig(profile))).token,
            }
          } else if (!address && typeof charm?.talk === "string") {
            // Voice was set up and this scheme cannot be given an address: say so rather than let the
            // charm keep calling an address the reader has just stopped using.
            voiceNote = VOICE_NO_TAILNET
          }
        } catch (error) {
          voiceNote = spoken(error, "Something went wrong")
        }
      }
      const done = await syncToCharm(bots, setProgress, {
        pet: { settings, poses },
        talk: talk ? { address: talk.address, mint: talk.mint } : undefined,
      })
      // Only a kept write is recorded: the record is what says nothing is owed, so a refusal written
      // there would leave a charm the page believes is set up and never offer it again.
      if (talk) recordCharmTalk(done.voice, talk.address, talk.bot)
      tell.success(done.total === 1 ? "1 bot on your charm" : `${done.total} bots on your charm`)
      if (done.petRefused && settings.enabled)
        tell.info(
          done.petClockRefused
            ? "Your bots synced. Your phone's clock reads before 2020, so the charm would not take it and the pet's meters would stand still. Check the phone's date, then sync again."
            : "Your bots synced. This charm's firmware has no pet mode yet.",
        )
      if (talk && done.voice !== "sent")
        voiceNote = talkWords(done.voiceCode ?? CharmCode.BadMessage)
      if (voiceNote) tell.info(voiceNote)
      // The charm is awake on the other end, and its own answer is the row's truth.
      if (talk) await readVoice()
      // A sync just spent a connection and the charm is awake on the other end: the battery is
      // cheap to ask now, and the row is one sync fresher for it.
      await readCharmBattery().catch(quietly("reading the charm's battery"))
    } catch (error) {
      setFailure(spoken(error, "Something went wrong"))
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

  // The first bot the charm holds, which is the one a test alert names: the same order a sync sends.
  const first = sources[0]

  const test = async () => {
    if (!first) return
    setBusy("test")
    setFailure(null)
    try {
      await sendTestAlert(first)
      tell.success("Sent a test alert")
    } catch (error) {
      setFailure(spoken(error, "Something went wrong"))
    } finally {
      setBusy(null)
    }
  }

  return charm ? (
    <>
      <CharmSections
        charm={charm}
        report={report}
        firmware={firmware}
        sources={sources}
        botsRead={Boolean(profiles)}
        labels={labels}
        busy={busy}
        progress={progress}
        failure={failure}
        batteryNote={batteryNote}
        wake={wake}
        scheme={scheme}
        held={held}
        heldFailed={heldFailed}
        onSync={() => void sync()}
        onTest={() => void test()}
        onTogglePet={(on) => void togglePet(on)}
        onPickPet={() => setPicking(true)}
        onWake={(next) => void applyWake(next)}
        onScheme={setCharmVoice}
        onBattery={refreshBattery}
        onForget={() => setForgetting(true)}
      />
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
      {failure && <Banner tone="error">{failure}</Banner>}
      <Group>
        <button type="button" className={rowClass} onClick={pair} disabled={busy !== null}>
          <LinkIcon link="bluetooth" />
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
 * The control that asks the charm for its charge. What the charm answered is the status row's line,
 * so this row says what a tap does — and, when an ask failed, why it did.
 */
export function BatteryRow({
  note,
  busy,
  onRefresh,
}: {
  /** Why the last ask failed, in words: the row's line while it stands. */
  note?: string
  busy: boolean
  onRefresh: () => void
}) {
  return (
    <button type="button" className={rowClass} onClick={onRefresh} disabled={busy}>
      <BatteryMediumIcon className="size-5 shrink-0 text-muted-foreground" />
      <RowText title="Battery" subtitle={note ?? BATTERY_ASK} />
    </button>
  )
}
