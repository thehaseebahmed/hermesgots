import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react"
import { Navigate, useParams } from "react-router"
import { toast } from "sonner"

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
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Switch } from "@/components/ui/switch"
import { listProfiles } from "@/lib/db"
import { searchCatalogue } from "@/lib/mcp-catalogue"
import {
  useMcpCatalogue,
  useMcpFeatureAnswers,
  useMcpServers,
  MCP_STATE_WORDS,
  type McpServerConfig,
} from "@/lib/mcps"
import type { McpCatalogueEntry, McpServer, McpState } from "@/lib/hermes"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"

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
 * as a searchable list, marking the entries this Bot already has and adding nothing, wherever the
 * Host advertises that it can read one. Reached from the Bot's own row in Settings and by URL; back
 * returns to the Bot. A Bot whose Hermes can't list them has no screen at all, so its URL sends the
 * user back to the Bot, while one whose Host hasn't answered yet draws nothing rather than flashing
 * its screen away.
 */
export function McpsPage() {
  const { botId } = useParams()
  const { up } = useNav()
  const profiles = useLiveQuery(listProfiles, [])
  const profile = profiles?.find((p) => p.id === botId)
  const { list, write, removable, catalogue } = useMcpFeatureAnswers(profile)
  const { servers, setEnabled, remove } = useMcpServers(profile, list === "yes")
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

      {/* Adding one starts in the Catalogue, so the action exists only where the Host has one. */}
      {catalogue === "yes" && (
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

      <McpCatalogueSheet open={browsing} onOpenChange={setBrowsing} server={profile} />

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
 * this Bot already has it, and a search over both the names and what Hermes says each entry is. Read
 * from the Host each time it is opened and nothing more — nothing is polled, since nothing in a
 * catalogue moves on its own, and nothing is added: adding one is its own step. A search that was
 * typed and matched nothing says so rather than reading as a Host with no catalogue at all.
 */
function McpCatalogueSheet({
  open,
  onOpenChange,
  server,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  server: McpServerConfig
}) {
  const entries = useMcpCatalogue(server, open)
  const [query, setQuery] = useState("")
  const shown = entries === undefined ? undefined : searchCatalogue(entries, query)
  return (
    <Popup
      open={open}
      onOpenChange={(next) => {
        // What was searched for is a fresh start the next time it is opened.
        if (!next) setQuery("")
        onOpenChange(next)
      }}
    >
      <PopupContent initialFocus={false}>
        <PopupHeader>
          <PopupTitle>Catalogue</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-4 px-6 pt-2 pb-4">
          <InputGroup className="h-11">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search the catalogue"
              aria-label="Search the catalogue"
            />
          </InputGroup>
          {shown === undefined ? null : shown.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">
              {query.trim() ? `Nothing matches “${query.trim()}”.` : "No entries."}
            </p>
          ) : (
            <Group>
              {shown.map((entry) => (
                <CatalogueRow key={entry.name} entry={entry} />
              ))}
            </Group>
          )}
        </div>
      </PopupContent>
    </Popup>
  )
}

/** One Catalogue entry: what Hermes calls it, what it is, and whether this Bot already has it. */
function CatalogueRow({ entry }: { entry: McpCatalogueEntry }) {
  return (
    <div className={rowClass} data-catalogue={entry.name}>
      <ServerIcon className="size-5 shrink-0 text-muted-foreground" />
      <RowText title={entry.name} subtitle={entry.description || undefined} />
      {entry.installed && <Badge variant="secondary">Added</Badge>}
    </div>
  )
}
