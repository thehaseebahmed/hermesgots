import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { ArrowLeftIcon, ChevronRightIcon, PlusIcon, ServerIcon, Trash2Icon } from "lucide-react"
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { listProfiles } from "@/lib/db"
import { collectedValues, fieldValue, missingValues, searchCatalogue } from "@/lib/mcp-catalogue"
import {
  useMcpCatalogue,
  useMcpCatalogueEntry,
  useMcpFeatureAnswers,
  useMcpServers,
  MCP_STATE_WORDS,
  type McpServerConfig,
} from "@/lib/mcps"
import type { McpCatalogueEntry, McpServer, McpState } from "@/lib/hermes"
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
  const { list, write, removable, catalogue, add } = useMcpFeatureAnswers(profile)
  const { servers, setEnabled, remove, install } = useMcpServers(profile, list === "yes")
  // The name of the server a removal is being confirmed for, and whether that removal is on its way.
  const [removing, setRemoving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [browsing, setBrowsing] = useState(false)
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
              onToggle={setEnabled}
              onRemove={() => setRemoving(server.name)}
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
 */
function ServerRow({
  server,
  writable,
  removable,
  onToggle,
  onRemove,
}: {
  server: McpServer
  writable: boolean
  removable: boolean
  onToggle: (name: string, enabled: boolean) => Promise<void>
  onRemove: () => void
}) {
  const [saving, setSaving] = useState(false)
  // A server a Hermes plugin provides is read-only, and so is every row of a Host that can't write,
  // so neither a switch nor a removal is offered where one could only come back refused.
  const editable = server.source === "config" && writable
  const droppable = editable && removable
  return (
    <div className={rowClass} data-mcp={server.name}>
      <ServerIcon className="size-5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-base">{server.name}</span>
        {server.reason && <span className="text-sm text-destructive">{server.reason}</span>}
      </span>
      <Badge variant={STATE_TONES[server.state]}>{MCP_STATE_WORDS[server.state]}</Badge>
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
 * One Catalogue entry's form: a field per value the entry declares, and the Add that writes them.
 *
 * What is typed in lives in this component's own state and nowhere else — it is never written to the
 * device and never read back from the Host, which reports only whether it already holds a value for
 * a declared one. Such a value has no field at all: its row says it is set and offers nothing to
 * type into, because its content is the Host's and asking for it again would mean showing it. A
 * secret's field is masked, and a required one is marked; a required field left empty (or a space or
 * two, which is nothing typed in) refuses the add and marks that field. Adding closes the form and
 * the Catalogue behind it, and what the screen's list becomes is the Host's own answer; a Host that
 * refuses the add answers with its own reason, which the form reports.
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
      <PopupHeader className="pl-16">
        <Button
          variant="ghost"
          size="icon-lg"
          className="absolute top-1.5 left-2 size-11"
          aria-label="Catalogue"
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <PopupTitle>{name}</PopupTitle>
      </PopupHeader>
      <div className="flex flex-col gap-4 px-6 pt-2 pb-4">
        {/* A read that came back an error: said, rather than left as a form with nothing in it. */}
        {failed && entry === undefined && (
          <p className="px-1 text-sm text-muted-foreground">Couldn't load this entry's values.</p>
        )}
        <FieldGroup>
          {entry?.values.map((value) => (
            <Field key={value.name} data-value={value.name} data-required={value.required}>
              <FieldLabel htmlFor={`mcp-value-${value.name}`}>
                {value.name}
                {value.required && !value.set && <Badge variant="outline">Required</Badge>}
              </FieldLabel>
              {value.set ? (
                <Badge variant="secondary">Set</Badge>
              ) : (
                <Input
                  id={`mcp-value-${value.name}`}
                  // A credential is masked as it is typed; a plain value is not.
                  type={value.secret ? "password" : "text"}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={fieldValue(value, entered)}
                  aria-invalid={missing.includes(value.name)}
                  onChange={(e) => {
                    const given = e.target.value
                    setEntered((current) => ({ ...current, [value.name]: given }))
                    // Filling a field in takes the mark off it: the refusal was about the field as it
                    // was, and the next Add is what judges it again.
                    setMissing((current) => current.filter((name) => name !== value.name))
                  }}
                />
              )}
              {value.prompt && <FieldDescription>{value.prompt}</FieldDescription>}
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
