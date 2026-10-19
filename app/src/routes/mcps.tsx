import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  KeyRoundIcon,
  PlusIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react"
import { Navigate, useParams } from "react-router"
import { toast } from "sonner"

import { ItemSearch } from "@/components/item-list"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Group, linkRowClass, rowClass, RowText, Screen } from "@/components/settings-chrome"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { listProfiles } from "@/lib/db"
import { MCP_WORK_MS } from "@/lib/freshness"
import { collectedValues, fieldValue, missingValues, searchCatalogue } from "@/lib/mcp-catalogue"
import { offersAccess } from "@/lib/mcp-access"
import {
  useMcpCatalogue,
  useMcpCatalogueEntry,
  useMcpFeatureAnswers,
  useMcpServers,
  MCP_STATE_WORDS,
  type McpServerConfig,
} from "@/lib/mcps"
import type { McpAccess, McpCatalogueEntry, McpServer, McpState } from "@/lib/hermes"
import { useWide } from "@/lib/media"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"

/**
 * How tall the sheet holding the Catalogue is, so it holds between its two views — the entries, then
 * one entry's form — the way the model picker's does.
 */
const CATALOGUE_HEIGHT = "h-[min(32rem,85dvh)]"

/** How loud each state reads: a failed server is the only one that is a problem. */
const STATE_TONES: Record<McpState, "secondary" | "outline" | "destructive"> = {
  on: "secondary",
  off: "outline",
  connecting: "outline",
  failed: "destructive",
  needs_access: "outline",
  plugin: "outline",
}

/**
 * A Bot's MCP servers: every one the Bot's Hermes profile has, each with the state it is in, a
 * switch that turns one on or off for that Bot and a removal behind a confirmation, each wherever
 * its own feature is advertised. A server a Hermes plugin provides is read as what it is and carries
 * no control, because Hermes refuses to modify one; a Host that can list servers without being able
 * to change them has no switch, and one that can switch but predates the removal has no removal, so
 * no control is ever offered whose every tap could only fail. An Add action opens Hermes's Catalogue
 * as a searchable list, marking the entries this Bot already has and adding the one that is picked —
 * its form asking for the values that entry declares — wherever the Host advertises both that it can
 * read a Catalogue and that it can add from one, since the action's whole work is the adding.
 * Reached from the Bot's own row in Settings and by URL; back returns to the Bot. A Bot whose Hermes
 * can't list them has no screen at all, so its URL sends the user back to the Bot, while one whose
 * Host hasn't answered yet draws nothing rather than flashing its screen away.
 */
export function McpsPage() {
  const { botId } = useParams()
  const { up } = useNav()
  const profiles = useLiveQuery(listProfiles, [])
  const profile = profiles?.find((p) => p.id === botId)
  const { list, write, removable, catalogue, add, access } = useMcpFeatureAnswers(profile)
  const { servers, setEnabled, remove, install, grant, deliver, reload } = useMcpServers(
    profile,
    list === "yes",
  )
  // The name of the server a removal is being confirmed for, and whether that removal is on its way.
  const [removing, setRemoving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  // The server whose Server access sheet is open, by name, so the sheet follows the row's own read.
  const [granting, setGranting] = useState<string | null>(null)
  const grantingServer = servers?.find((server) => server.name === granting)
  const profileId = profile?.id
  // Android's back does what the header's button does: it returns to the Bot.
  const back = useCallback(
    () => up(profileId ? `/settings/bots/${profileId}` : "/settings"),
    [up, profileId],
  )
  useEffect(() => setBackGuard(() => (back(), true)), [back])

  async function confirmRemove() {
    if (removing === null) return
    setBusy(true)
    try {
      // The list becomes the servers the Host says are left, so the row goes on the answer itself.
      await remove(removing)
      setRemoving(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't remove that.")
    } finally {
      setBusy(false)
    }
  }

  if (profiles === undefined) return null
  if (!profile) return <Navigate to="/settings" replace />
  // The plugin answered without the feature: there is nothing to list, so a hand-typed URL lands
  // back on the Bot rather than on a blank screen with no way out.
  if (list === "no") return <Navigate to={`/settings/bots/${profile.id}`} replace />
  // Still unanswered: nothing is drawn, so a good Bot's screen doesn't flash away on a direct visit.
  if (list !== "yes") return null

  return (
    <Screen
      title="MCP servers"
      leading={
        <Button
          variant="outline"
          size="icon-lg"
          className="size-11 rounded-full"
          onClick={() => up(`/settings/bots/${profile.id}`)}
          aria-label="Back"
        >
          <ArrowLeftIcon />
        </Button>
      }
    >
      {servers === undefined ? null : servers.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">No MCP servers.</p>
      ) : (
        <Group>
          {servers.map((server) => (
            <ServerRow
              key={server.name}
              server={server}
              writable={write === "yes"}
              removable={removable === "yes"}
              grantable={offersAccess(access === "yes", server.access)}
              onToggle={setEnabled}
              onRemove={() => setRemoving(server.name)}
              onGrant={() => setGranting(server.name)}
            />
          ))}
        </Group>
      )}

      {/* Adding one is the Catalogue plus the write that lands it, so the action exists only where
          the Host advertises both: a Host that can read a Catalogue but not add from one has no
          action whose whole work it couldn't do. */}
      {catalogue === "yes" && add === "yes" && (
        <Group>
          <button
            type="button"
            className={linkRowClass}
            aria-haspopup="dialog"
            onClick={() => setBrowsing(true)}
          >
            <PlusIcon className="size-5 shrink-0 text-muted-foreground" />
            <RowText title="Add a server" />
            <ChevronRightIcon className="size-5 shrink-0 text-muted-foreground" />
          </button>
        </Group>
      )}

      <McpCatalogueSheet
        open={browsing}
        onOpenChange={setBrowsing}
        server={profile}
        install={install}
      />

      {/* The flow is the Host's: the sheet starts it, shows the URL to open in a browser, and takes
          the address that browser ended on when it ran on this phone instead. It closes when the
          row's own read says the access landed. */}
      {grantingServer && (
        <ServerAccessSheet
          server={grantingServer}
          open
          onOpenChange={(next) => !next && setGranting(null)}
          grant={grant}
          deliver={deliver}
          reload={reload}
        />
      )}

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => !open && !busy && setRemoving(null)}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing}?</AlertDialogTitle>
            <AlertDialogDescription>
              The bot stops having it, and its stored access goes with it. The values you gave it
              stay on the host, so adding it again doesn't mean finding them twice.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => void confirmRemove()}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Screen>
  )
}

/**
 * One server: its name, the Host's own reason when it failed, Gots' word for its state, and the
 * switch and removal its Host advertises. Each control follows its own feature, so a Host that can
 * switch a server but not remove one offers the switch alone. The switch follows the server's own
 * on/off flag rather than the state word, which folds several of the Host's states into "on".
 *
 * Grant access is the one control a waiting or failing OAuth server offers: a labelled button where
 * there is room, and a key icon on a phone, where a row already carries a badge, a switch and a
 * removal. It follows the Host's own `access`, so the screen never decides for itself which server's
 * Server access can be started.
 */
function ServerRow({
  server,
  writable,
  removable,
  grantable,
  onToggle,
  onRemove,
  onGrant,
}: {
  server: McpServer
  writable: boolean
  removable: boolean
  grantable: boolean
  onToggle: (name: string, enabled: boolean) => Promise<void>
  onRemove: () => void
  onGrant: () => void
}) {
  const [saving, setSaving] = useState(false)
  const wide = useWide()
  // A server a Hermes plugin provides is read-only, and so is every row of a Host that can't write,
  // so neither a switch nor a removal is offered where one could only come back refused.
  const editable = server.source === "config" && writable
  const droppable = editable && removable
  const state = <Badge variant={STATE_TONES[server.state]}>{MCP_STATE_WORDS[server.state]}</Badge>
  // The key button costs a row ~44px it doesn't have beside the badge on a phone, so there the state
  // drops under the name rather than squeezing the name to a letter.
  const badgeUnderName = !wide && grantable
  return (
    <div className={rowClass} data-mcp={server.name}>
      <ServerIcon className="size-5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-base">{server.name}</span>
        {server.reason && <span className="text-sm text-destructive">{server.reason}</span>}
        {badgeUnderName && <span className="mt-1 self-start">{state}</span>}
      </span>
      {!badgeUnderName && state}
      {grantable && (
        <Button
          variant={wide ? "outline" : "ghost"}
          size={wide ? "sm" : "icon-lg"}
          className={
            wide
              ? "h-11 shrink-0 rounded-full"
              : "size-11 shrink-0 rounded-full text-muted-foreground"
          }
          onClick={onGrant}
          aria-label={`Grant access to ${server.name}`}
        >
          <KeyRoundIcon />
          {wide && "Grant access"}
        </Button>
      )}
      {editable && (
        <Switch
          aria-label={server.name}
          checked={server.enabled}
          disabled={saving}
          onCheckedChange={async (checked) => {
            setSaving(true)
            try {
              await onToggle(server.name, checked)
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "Couldn't save that.")
            } finally {
              setSaving(false)
            }
          }}
        />
      )}
      {droppable && (
        <Button
          variant="ghost"
          size="icon-lg"
          className="size-11 rounded-full text-muted-foreground"
          onClick={onRemove}
          aria-label={`Remove ${server.name}`}
        >
          <Trash2Icon />
        </Button>
      )}
    </div>
  )
}

/**
 * Server access for one server: the Host starts the flow, this sheet shows the URL it hands back,
 * and the user finishes it in a browser. The browser is usually on the host — the flow's callback
 * binds the host's loopback — so opening it on this phone leaves a connection-refused page whose
 * address still carries the authorization code; pasting that address back sends it to the Host over
 * the connection the app already has, and the Host exchanges the code. Nothing here grants anything
 * on its own, and nothing about the flow is kept on the device: reopening the sheet asks the Host
 * again, which answers the URL of the flow it is still running.
 *
 * The sheet waits for the row's own read to say on, then closes itself; the Host stops waiting for
 * the callback at its configured timeout, which is what the expiry ends the wait with.
 */
function ServerAccessSheet({
  server,
  open,
  onOpenChange,
  grant,
  deliver,
  reload,
}: {
  server: McpServer
  open: boolean
  onOpenChange: (open: boolean) => void
  grant: (name: string) => Promise<McpAccess>
  deliver: (name: string, url: string) => Promise<void>
  reload: () => Promise<void>
}) {
  const [flow, setFlow] = useState<McpAccess | undefined>(undefined)
  const [starting, setStarting] = useState(false)
  const [failed, setFailed] = useState<string | undefined>(undefined)
  const [expired, setExpired] = useState(false)
  const [pasted, setPasted] = useState("")
  const [sending, setSending] = useState(false)
  const [copied, setCopied] = useState(false)
  // Bumped by Try again: each start (and each retry) is one attempt at the flow.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setFlow(undefined)
    setFailed(undefined)
    setExpired(false)
    setPasted("")
    setStarting(true)
    void (async () => {
      try {
        const answer = await grant(server.name)
        if (cancelled) return
        // The stored access still works: nothing to open. The row is read once more before the sheet
        // closes, since a failed row's own read is not the one the screen's poll is following.
        if (!answer.url) {
          await reload()
          onOpenChange(false)
          return
        }
        setFlow(answer)
      } catch (error) {
        if (!cancelled)
          setFailed(error instanceof Error ? error.message : "Server access couldn't be started.")
      } finally {
        if (!cancelled) setStarting(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // `onOpenChange` is the parent's close, stable for the life of one open sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, attempt, server.name, grant, reload])

  // The Host stops waiting at its own timeout; the sheet stops with it rather than waiting forever.
  useEffect(() => {
    if (!open || !flow?.url || expired) return
    const timer = window.setTimeout(() => setExpired(true), Math.max(1, flow.expires) * 1000)
    return () => window.clearTimeout(timer)
  }, [open, flow, expired])

  // While the sheet is open on a running flow the row is read again at the screen's own work pace:
  // the screen's poll follows a connecting or waiting server, and a *failed* row a flow is running
  // for is neither, so without this the wait would never see the access land on that row.
  useEffect(() => {
    if (!open || !flow) return
    const timer = window.setInterval(() => void reload(), MCP_WORK_MS)
    return () => window.clearInterval(timer)
  }, [open, flow, reload])

  // The row's own read is the answer: once it says on, the access landed and the sheet is done.
  useEffect(() => {
    if (!open || !flow || server.state !== "on") return
    onOpenChange(false)
    toast.success("Access granted.")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, flow, server.state])

  async function copy() {
    if (!flow?.url) return
    try {
      await navigator.clipboard.writeText(flow.url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error("Couldn't copy that.")
    }
  }

  async function send() {
    const address = pasted.trim()
    if (!address) return
    setSending(true)
    try {
      await deliver(server.name, address)
      setPasted("")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That address couldn't be used.")
    } finally {
      setSending(false)
    }
  }

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader>
          <PopupTitle>Server access</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-4 px-4 pb-6">
          {starting ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              Starting…
            </p>
          ) : failed ? (
            <>
              <p className="text-sm text-destructive">{failed}</p>
              <Button
                variant="outline"
                className="h-11 rounded-full"
                onClick={() => setAttempt((count) => count + 1)}
              >
                Try again
              </Button>
            </>
          ) : flow?.url ? (
            <>
              <p className="text-sm text-muted-foreground">
                Open it on the host, or on this phone and paste the address it ends on.
              </p>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={flow.url}
                  aria-label="The address to open"
                  className="h-11 min-w-0 flex-1 font-mono text-sm"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button
                  variant="outline"
                  size="icon-lg"
                  className="size-11 shrink-0 rounded-full"
                  onClick={() => void copy()}
                  aria-label={copied ? "Copied" : "Copy address"}
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </Button>
              </div>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="mcp-access-callback">Address it ended on</FieldLabel>
                  <div className="flex items-center gap-2">
                    <Input
                      id="mcp-access-callback"
                      value={pasted}
                      onChange={(event) => setPasted(event.target.value)}
                      placeholder="http://127.0.0.1:…/callback?code=…"
                      className="h-11 min-w-0 flex-1 font-mono text-sm"
                      disabled={expired || sending}
                    />
                    <Button
                      className="h-11 shrink-0 rounded-full"
                      disabled={!pasted.trim() || sending || expired}
                      onClick={() => void send()}
                    >
                      {sending && <Spinner />}
                      Send
                    </Button>
                  </div>
                </Field>
              </FieldGroup>
              {expired ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-muted-foreground">That took too long.</p>
                  <Button
                    variant="outline"
                    className="h-11 rounded-full"
                    onClick={() => setAttempt((count) => count + 1)}
                  >
                    Try again
                  </Button>
                </div>
              ) : (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner />
                  Waiting for the host…
                </p>
              )}
            </>
          ) : null}
        </div>
      </PopupContent>
    </Popup>
  )
}

/**
 * Hermes's Catalogue as the Bot's Host offers it: every entry Hermes has, each marked with whether
 * this Bot already has it and a search over both the names and what Hermes says each entry is. Read
 * from the Host each time it is opened and nothing more — nothing is polled, since nothing in a
 * catalogue moves on its own. A search that was typed and matched nothing says so rather than
 * reading as a Host with no catalogue at all. Picking an entry opens its form as a sheet of its own,
 * stacked on this one, so the list is one back away and the form never sits over the entry it is
 * about; adding writes the Bot and closes both, and the servers the Host answers with take the
 * screen's list.
 */
function McpCatalogueSheet({
  open,
  onOpenChange,
  server,
  install,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  server: McpServerConfig
  install: (name: string, values: Record<string, string>) => Promise<void>
}) {
  const entries = useMcpCatalogue(server, open)
  const [query, setQuery] = useState("")
  // The entry whose form is open, by name: one at a time, above the list it was picked from.
  const [picking, setPicking] = useState<string | undefined>(undefined)
  const shown = entries === undefined ? undefined : searchCatalogue(entries, query)
  return (
    <Popup
      open={open}
      onOpenChange={(next) => {
        // What was searched for, and the form if one was open, are a fresh start next time.
        if (!next) {
          setQuery("")
          setPicking(undefined)
        }
        onOpenChange(next)
      }}
    >
      <PopupContent initialFocus={false} fixedHeight={CATALOGUE_HEIGHT}>
        <PopupHeader>
          <PopupTitle>Catalogue</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-4 px-6 pt-2 pb-4">
          <ItemSearch value={query} onChange={setQuery} label="Search the catalogue" />
          {shown === undefined ? null : shown.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">
              {query.trim() ? `Nothing matches “${query.trim()}”.` : "No entries."}
            </p>
          ) : (
            <Group>
              {shown.map((entry) => (
                <CatalogueRow
                  key={entry.name}
                  entry={entry}
                  onOpen={() => setPicking(entry.name)}
                />
              ))}
            </Group>
          )}
        </div>
        {/* One entry's form: a sheet stacked on this one, dismissed back to the Catalogue. It renders
            inside this sheet's tree so Base UI registers the nesting. */}
        {picking && (
          <Popup open onOpenChange={(next) => !next && setPicking(undefined)}>
            <PopupContent initialFocus={false} fixedHeight={CATALOGUE_HEIGHT}>
              <McpEntryForm
                server={server}
                name={picking}
                install={install}
                onBack={() => setPicking(undefined)}
                onAdded={() => {
                  setPicking(undefined)
                  onOpenChange(false)
                }}
              />
            </PopupContent>
          </Popup>
        )}
      </PopupContent>
    </Popup>
  )
}

/** One Catalogue entry: what Hermes calls it, what it is, and whether this Bot already has it. */
function CatalogueRow({ entry, onOpen }: { entry: McpCatalogueEntry; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={linkRowClass}
      data-catalogue={entry.name}
      aria-haspopup="dialog"
      onClick={onOpen}
    >
      <ServerIcon className="size-5 shrink-0 text-muted-foreground" />
      <RowText title={entry.name} subtitle={entry.description || undefined} />
      {entry.installed && <Badge variant="secondary">Added</Badge>}
      <ChevronRightIcon className="size-5 shrink-0 text-muted-foreground" />
    </button>
  )
}

/**
 * What a field for a value the Bot already holds says: the Host reports that it has one and never its
 * content, so the field stands empty with this as its placeholder and typing over it replaces the
 * value.
 */
const SET_PLACEHOLDER = "Set — type to replace"

/**
 * One Catalogue entry's form: a field per value the entry declares, and the Add that writes them.
 *
 * What is typed in lives in this component's own state and nowhere else — it is never written to the
 * device and never read back from the Host, which reports only whether it already holds a value for
 * a declared one. A field is titled with the prompt the entry writes for people and subtitled with
 * the name the value lands under on the Host, a secret's is masked, and a required one is starred;
 * a required field left empty (or a space or two, which is nothing typed in) refuses the add and
 * marks that field. A value the Bot already holds has a field of its own, standing empty and saying
 * so: typing into it replaces what the Host holds, and leaving it alone sends nothing at all. Adding
 * closes the form and the Catalogue behind it, and what the screen's list becomes is the Host's own
 * answer; a Host that refuses the add answers with its own reason, which the form reports.
 */
function McpEntryForm({
  server,
  name,
  install,
  onBack,
  onAdded,
}: {
  server: McpServerConfig
  name: string
  install: (name: string, values: Record<string, string>) => Promise<void>
  onBack: () => void
  onAdded: () => void
}) {
  const { entry, failed } = useMcpCatalogueEntry(server, name, true)
  const [entered, setEntered] = useState<Record<string, string>>({})
  const [missing, setMissing] = useState<string[]>([])
  const [adding, setAdding] = useState(false)

  async function add() {
    if (!entry) return
    const gaps = missingValues(entry.values, entered)
    setMissing(gaps)
    if (gaps.length) return
    setAdding(true)
    try {
      await install(entry.name, collectedValues(entry.values, entered))
      onAdded()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't add that.")
    } finally {
      setAdding(false)
    }
  }

  return (
    <>
      {/* The back control and the title share one row so the two line up: an absolutely placed control
          beside a centred title leaves the title off the sheet's middle and the control sitting low. */}
      <PopupHeader className="flex-row items-center gap-2 pl-2 text-left">
        <Button
          variant="ghost"
          size="icon-lg"
          className="size-11 shrink-0"
          aria-label="Catalogue"
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <PopupTitle className="justify-start text-left">{name}</PopupTitle>
        </div>
      </PopupHeader>
      <div className="flex flex-col gap-4 px-6 pt-2 pb-4">
        {/* A read that came back an error: said, rather than left as a form with nothing in it. */}
        {failed && entry === undefined && (
          <p className="px-1 text-sm text-muted-foreground">Couldn't load this entry's values.</p>
        )}
        <FieldGroup>
          {entry?.values.map((value) => (
            <Field key={value.name} data-value={value.name} data-required={value.required}>
              {/* Hermes names a value twice: the prompt its manifest writes for people, and the name
                  the value lands under on the Host. The prompt is the title and the name is the
                  subtext, so a field reads as the thing being asked for, not as an env var. */}
              <FieldLabel
                htmlFor={`mcp-value-${value.name}`}
                className="flex-col items-start gap-0.5"
              >
                <span>
                  {value.prompt || value.name}
                  {value.required && <span aria-hidden="true">{" *"}</span>}
                </span>
                {value.prompt && (
                  <span className="text-xs font-normal text-muted-foreground">{value.name}</span>
                )}
              </FieldLabel>
              <Input
                id={`mcp-value-${value.name}`}
                className="h-11"
                // A credential is masked as it is typed; a plain value is not.
                type={value.secret ? "password" : "text"}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder={value.set ? SET_PLACEHOLDER : undefined}
                value={fieldValue(value, entered)}
                aria-required={value.required || undefined}
                aria-invalid={missing.includes(value.name)}
                onChange={(e) => {
                  const given = e.target.value
                  setEntered((current) => ({ ...current, [value.name]: given }))
                  // Filling a field in takes the mark off it: the refusal was about the field as it
                  // was, and the next Add is what judges it again.
                  setMissing((current) => current.filter((name) => name !== value.name))
                }}
              />
            </Field>
          ))}
        </FieldGroup>
        <Button
          size="lg"
          className="h-11 rounded-full"
          disabled={adding || !entry}
          onClick={() => void add()}
        >
          Add
        </Button>
      </div>
    </>
  )
}
