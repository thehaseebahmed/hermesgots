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
import { getActiveProfile, listProfiles } from "@/lib/db"
import type { PluginServer } from "@/lib/features"
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
import { talkWords, voiceAddress, voiceOwed } from "@/lib/talk"
import { tell } from "@/lib/tell"
import { useBotLabels } from "@/lib/use-bot-labels"

const message = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "Something went wrong"

/** How often a running firmware download is asked where it has got to. */
const UPDATE_POLL_MS = 2_000

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
 * Settings → Charm's network: the Wi-Fi the charm joins, the tailnet key it joins with, and the
 * firmware it runs — the version it says it has beside the one the package publishes, and the two
 * doors onto the update's own screen: an update when the published one is newer, a file otherwise.
 * Every row draws the charm's own answer rather than what was sent, and a passphrase or a key clears
 * the moment the write has gone: neither is ever drawn again, and neither is kept on this phone.
 */
export function CharmNetwork({
  api = RADIO,
  profile,
  record,
  tailnet,
  read,
  refresh,
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
}) {
  const [update, setUpdate] = useState<CharmRead<CharmUpdateStatus>>({ state: "reading" })
  const [ssid, setSsid] = useState("")
  const [pass, setPass] = useState("")
  const [key, setKey] = useState("")
  /** Which build the charm runs, as its own answer says. */
  const [running, setRunning] = useState<CharmRunning>({ state: "reading" })
  /**
   * What the host says `latest` holds, as one of its own records: read when the row opens, kept for
   * its next open, and read again when a merge may have moved the tag. A plugin older than the route
   * answers nothing, and the row says it couldn't check.
   */
  const firmware = useHostRecord(profile, PUBLISHED_FIRMWARE, undefined)
  const seen = firmware.value
  const published = seen?.state === "published" ? seen.firmware : undefined
  /** The host's own sentence where its read was refused, which is not a charmed-nothing-said. */
  const checkSaid = seen?.state === "refused" ? seen.said : null
  const [busy, setBusy] = useState<"wifi" | "forget" | "tailnet" | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [watching, setWatching] = useState(false)

  /** The two versions the row compares: the charm's own, and the package's as its host reads it. */
  const versions = { running, published: published?.version, answered: firmware.settled }
  const offers = firmwareOffers(versions)

  /** What the charm last answered about its two links, and where its download had got to. */
  const links = readValue(read)
  const downloading = readValue(update)

  /**
   * Where the charm's download has got to, asked when the section opens and again after each write. A
   * failed ask keeps what an earlier one found — the charm is out of reach, not empty — and says why,
   * since refused, disconnected and timed out are three facts rather than one silence.
   */
  const readUpdate = useCallback(
    () =>
      api.updateStatus().then(
        (value) => {
          setUpdate({ state: "read", value })
          return value
        },
        (reason: unknown) => {
          quietly("reading the charm's download")(reason)
          setUpdate(readFailed)
          return undefined
        },
      ),
    [api],
  )

  /**
   * The charm's own version when the row opens: a version it can't say stays unsaid rather than
   * guessed, and a link that never opened is its own fact. What the package publishes is the host's
   * record above, read alongside it.
   */
  useEffect(() => {
    void api.version().then(
      (found) =>
        setRunning(found === null ? { state: "too-old" } : { state: "says", version: found }),
      () => setRunning({ state: "unreachable" }),
    )
  }, [api])

  // The download's own line: read once on opening, and again after each write.
  useEffect(() => {
    void readUpdate().then((found) => {
      // A download already running when the row opens is followed to its end, as one it started was.
      if (found?.state === CharmUpdateState.Downloading) setWatching(true)
    })
  }, [readUpdate])

  // A download that is running is asked where it has got to until it stops running.
  useEffect(() => {
    if (!watching) return
    let live = true
    const timer = setInterval(() => {
      void api
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
      // A write the charm kept is read back: its links and its download, from the same asks as before.
      if (charmKept(code)) await Promise.all([refresh(), readUpdate()])
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
      <Group>
        <div className={headerRowClass}>
          <CloudDownloadIcon className="size-5 shrink-0 text-muted-foreground" />
          <RowText title="Firmware" subtitle={firmwareWords(versions)} />
        </div>
        <div className={formRowClass}>
          <div className="flex flex-wrap items-center gap-2">
            {offers && published && (
              <Button
                id="charm-update-start"
                type="button"
                disabled={busy !== null}
                onClick={() => navigate("/settings/charm-firmware")}
              >
                Update to {published.version}
              </Button>
            )}
            <Button
              id="charm-update-pick"
              type="button"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => navigate("/settings/charm-firmware?file=1")}
            >
              <FileUpIcon />
              Choose a file…
            </Button>
          </div>
        </div>
      </Group>
      {checkSaid && <Caption>{checkSaid}</Caption>}
      <Caption>{FIRMWARE_CAPTION}</Caption>
      {downloading && downloading.state !== CharmUpdateState.Idle && (
        <Caption>{updateWords(downloading)}</Caption>
      )}
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

export function CharmSettings() {
  const charm = usePairedCharm()
  const profiles = useLiveQuery(listProfiles, [])
  /** The bot whose host publishes the firmware: the row's own read of it is that host's record. */
  const profile = useLiveQuery(getActiveProfile, [])
  const labels = useBotLabels()
  const [busy, setBusy] = useState<"pair" | "sync" | "test" | "wake" | "battery" | null>(null)
  /** The page's own read of the charm's links: the status row and the Network section both draw it. */
  const { read: status, refresh: refreshStatus } = useCharmReport()
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
          voiceNote = message(error)
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
        tell.info("Your bots synced. This charm's firmware has no pet mode yet.")
      if (talk && done.voice !== "sent")
        voiceNote = talkWords(done.voiceCode ?? CharmCode.BadMessage)
      if (voiceNote) tell.info(voiceNote)
      // The charm is awake on the other end, and its own answer is the row's truth.
      if (talk) await readVoice()
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
            <CharmStatusRow charm={charm} status={status} battery={charm.battery} />
            <BatteryRow note={batteryNote} busy={busy !== null} onRefresh={refreshBattery} />
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
            <CharmVoiceScheme
              scheme={scheme}
              disabled={busy !== null}
              onChange={setCharmVoice}
            />
            <CharmVoiceHeld address={held} failed={heldFailed} />
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
          <CharmNetwork
            profile={profile}
            record={charm.wifi}
            tailnet={charm.tailnet}
            read={status}
            refresh={refreshStatus}
          />
          <Group>
            <ActionRow
              icon={UnlinkIcon}
              title="Forget this charm"
              onClick={() => setForgetting(true)}
            />
          </Group>
          <Caption>
            Keep the charm close while it syncs. Afterwards it shows your bots on its own, with the
            phone away. It holds names and pictures, and — once voice is set up — the address it
            calls and its own token. Nothing else leaves the phone, and the token is kept nowhere
            else.
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
