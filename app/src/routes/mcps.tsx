import { useEffect, useState } from "react"
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  PlusIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { ItemSearch } from "@/components/item-list"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Group, linkRowClass, rowClass, RowText } from "@/components/settings-chrome"
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
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { Profile } from "@/lib/db"
import { offersAccess } from "@/lib/mcp-access"
import { collectedValues, fieldValue, missingValues, searchCatalogue } from "@/lib/mcp-catalogue"
import {
  configChanged,
  configDraft,
  configEdit,
  customReady,
  transportReady,
  customServer,
  healthLine,
  type ConfigDraft,
  type ValueDraft,
} from "@/lib/mcp-server"
import {
  useMcpCatalogue,
  useMcpCatalogueEntry,
  useMcpFeatureAnswers,
  useMcpServerDetail,
  useMcpServers,
  useMcpServerTools,
  type McpServerConfig,
} from "@/lib/mcps"
import type {
  McpAccess,
  McpCatalogueEntry,
  McpCustomServer,
  McpServer,
  McpServerDetail,
  McpServerEdit,
} from "@/lib/hermes"
import { cn } from "@/lib/utils"

/** How tall the sheet holding the Catalogue is, so it holds its two views the way the picker does. */
const CATALOGUE_HEIGHT = "h-[min(32rem,85dvh)]"

/** How tall a server's own sheet is, so its two tabs hold their place between switches. */
const SERVER_HEIGHT = "h-[min(34rem,85dvh)]"

/**
 * What a field for a value the Bot already holds says: the Host reports that it has one and never its
 * content, so the field stands empty with this as its placeholder, and typing over it replaces it.
 */
const SET_PLACEHOLDER = "Set — type to replace"

/**
 * A bot's MCP servers, as a tab of its Settings: Add a server on top, then the servers the bot's own
 * configuration holds, then the ones a Hermes plugin provides.
 *
 * Every row is its name over its health — *Healthy: 78 tools* where Hermes reports a count, the
 * Host's own sentence where it failed, *Click here to authenticate* where
 * Server access is what stands in the way — and that health line is the button starting the flow, so
 * the waiting row and the way out of it are one line. Tapping the name opens the server's own sheet:
 * Config, where its block is shown and saved, and Tools, where what it offers is listed (ADR 0014).
 *
 * A heading with nothing under it is left out, so a bot with no servers shows the Add row alone. The
 * Add action's two ways in — the Catalogue and the custom form — need the same write a Config save
 * does, so neither is offered where the Host can't write.
 */
export function McpsTab({ profile }: { profile: Profile }) {
  const answers = useMcpFeatureAnswers(profile)
  // The server whose Server access sheet is open, by name: while it is, the screen keeps reading, so
  // the wait sees the access land on a row whose own state would never move it.
  const [granting, setGranting] = useState<string | null>(null)
  const { servers, setEnabled, remove, saveConfig, addCustom, install, grant, deliver, reload } =
    useMcpServers(profile, answers.list === "yes", granting !== null)
  const [adding, setAdding] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [customising, setCustomising] = useState(false)
  // The server whose sheet is open, by name.
  const [opened, setOpened] = useState<string | null>(null)
  // The server a removal is being confirmed for, and whether that removal is on its way.
  const [removing, setRemoving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const openedServer = servers?.find((server) => server.name === opened)
  const grantingServer = servers?.find((server) => server.name === granting)
  const mine = servers?.filter((server) => server.source === "config") ?? []
  const theirs = servers?.filter((server) => server.source === "plugin") ?? []
  // A sheet only exists where the Host advertises a tab for it, so a row whose name could open
  // nothing keeps its name plain.
  const sheetOpenable = answers.config === "yes" || answers.tools === "yes"

  async function confirmRemove() {
    if (removing === null) return
    setBusy(true)
    try {
      await remove(removing)
      setRemoving(null)
      setOpened(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't remove that.")
    } finally {
      setBusy(false)
    }
  }

  // Nothing is drawn until the Host has answered that it lists servers: the tab only exists for a
  // Host that does, so a blank frame here is the tab arriving rather than a bot without one.
  if (answers.list !== "yes") return null

  return (
    <div className="flex flex-col gap-4" data-mcp-tab>
      {answers.add === "yes" && (
        <Group>
          <button
            type="button"
            className={linkRowClass}
            aria-haspopup="dialog"
            data-mcp-add
            onClick={() => setAdding(true)}
          >
            <PlusIcon className="size-5 shrink-0 text-muted-foreground" />
            <RowText title="Add a server" />
            <ChevronRightIcon className="size-5 shrink-0 text-muted-foreground" />
          </button>
        </Group>
      )}

      {mine.length > 0 && (
        <section className="flex flex-col gap-2" data-mcp-section="config">
          <h2 className="px-2 text-sm font-medium text-muted-foreground">Your servers</h2>
          <Group>
            {mine.map((server) => (
              <ServerRow
                key={server.name}
                server={server}
                writable={answers.write === "yes"}
                canAuthenticate={offersAccess(answers.access === "yes", server.access)}
                openable={sheetOpenable}
                onToggle={setEnabled}
                onOpen={() => setOpened(server.name)}
                onGrant={() => setGranting(server.name)}
              />
            ))}
          </Group>
        </section>
      )}

      {theirs.length > 0 && (
        <section className="flex flex-col gap-2" data-mcp-section="plugin">
          <h2 className="px-2 text-sm font-medium text-muted-foreground">From plugins</h2>
          <Group>
            {theirs.map((server) => (
              <ServerRow
                key={server.name}
                server={server}
                writable={false}
                canAuthenticate={false}
                openable={sheetOpenable}
                onToggle={setEnabled}
                onOpen={() => setOpened(server.name)}
                onGrant={() => setGranting(server.name)}
              />
            ))}
          </Group>
        </section>
      )}

      <AddServerSheet
        open={adding}
        onOpenChange={setAdding}
        onCatalogue={() => {
          setAdding(false)
          setBrowsing(true)
        }}
        onCustom={() => {
          setAdding(false)
          setCustomising(true)
        }}
        catalogue={answers.catalogue === "yes"}
        custom={answers.add === "yes"}
      />

      <McpCatalogueSheet
        open={browsing}
        onOpenChange={setBrowsing}
        server={profile}
        install={install}
      />

      <CustomServerSheet open={customising} onOpenChange={setCustomising} add={addCustom} />

      {openedServer && (answers.config === "yes" || answers.tools === "yes") && (
        <ServerSheet
          profile={profile}
          server={openedServer}
          open
          onOpenChange={(next) => !next && setOpened(null)}
          config={answers.config === "yes"}
          tools={answers.tools === "yes"}
          removable={answers.removable === "yes"}
          saveConfig={saveConfig}
          onRemove={() => setRemoving(openedServer.name)}
        />
      )}

      {/* The flow is the Host's: the sheet starts it, shows the URL to open in a browser, and takes
          the address that browser ended on when it ran on this phone instead. */}
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
    </div>
  )
}

/** A row of buttons where one of a few values is active, each a full-height touch target. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  label: string
  disabled?: boolean
}) {
  return (
    <div role="group" aria-label={label} className="flex gap-2">
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          variant={value === option.value ? "default" : "outline"}
          className="h-11 flex-1 rounded-full"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}

/**
 * One server: its name, its health, and the switch its Host advertises.
 *
 * The name is the button opening the server's sheet, and the health line sits under it — a button of
 * its own where it is the way to start Server access, plain text everywhere else. The switch follows
 * the server's own on/off flag rather than its state word, which folds several of the Host's states
 * into "on", and it is the only control a row carries: removing a server lives in its Config tab
 * with the rest of what changes it.
 */
function ServerRow({
  server,
  writable,
  canAuthenticate,
  openable,
  onToggle,
  onOpen,
  onGrant,
}: {
  server: McpServer
  writable: boolean
  canAuthenticate: boolean
  openable: boolean
  onToggle: (name: string, enabled: boolean) => Promise<void>
  onOpen: () => void
  onGrant: () => void
}) {
  const [saving, setSaving] = useState(false)
  const line = healthLine(server, { canAuthenticate })
  // A server a Hermes plugin provides is read-only, and so is every row of a Host that can't write,
  // so no switch is offered where one could only come back refused.
  const editable = server.source === "config" && writable
  return (
    <div className={rowClass} data-mcp={server.name}>
      <ServerIcon className="size-5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        {openable ? (
          <button
            type="button"
            className="min-w-0 truncate rounded-lg text-left text-base outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            aria-haspopup="dialog"
            onClick={onOpen}
          >
            {server.name}
          </button>
        ) : (
          // A Host that can't show a server's sheet leaves its name plain, rather than a button
          // that would open nothing.
          <span className="truncate text-base">{server.name}</span>
        )}
        {line.authenticate ? (
          // A failure the Host says access can fix stays a failure to read, so its colour comes from
          // that rather than from the line being tappable.
          <button
            type="button"
            className={cn(
              // The line reads exactly where a plain subtitle would: its 44px touch target grows
              // below the text, and the negative margin keeps that height out of the row's layout.
              "-mx-1 -mb-6 flex min-h-11 items-start px-1 text-left text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
              line.failed ? "text-destructive" : "text-warning",
            )}
            onClick={onGrant}
          >
            {line.text}
          </button>
        ) : (
          <span
            className={cn(
              "line-clamp-2 text-sm",
              line.failed ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {line.text}
          </span>
        )}
      </span>
      {editable && (
        <Switch
          aria-label={`${server.name} on`}
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
    </div>
  )
}

/** The Add row's two ways in: Hermes's Catalogue, or a server typed in by hand. */
function AddServerSheet({
  open,
  onOpenChange,
  onCatalogue,
  onCustom,
  catalogue,
  custom,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCatalogue: () => void
  onCustom: () => void
  catalogue: boolean
  custom: boolean
}) {
  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent initialFocus={false}>
        <PopupHeader>
          <PopupTitle>Add a server</PopupTitle>
        </PopupHeader>
        <div className="px-4 pb-6">
          <Group>
            {catalogue && (
              <button
                type="button"
                className={linkRowClass}
                data-mcp-source="catalogue"
                onClick={onCatalogue}
              >
                <ServerIcon className="size-5 shrink-0 text-muted-foreground" />
                <RowText title="Catalogue" />
                <ChevronRightIcon className="size-5 shrink-0 text-muted-foreground" />
              </button>
            )}
            {custom && (
              <button
                type="button"
                className={linkRowClass}
                data-mcp-source="custom"
                onClick={onCustom}
              >
                <PlusIcon className="size-5 shrink-0 text-muted-foreground" />
                <RowText title="Custom server" />
                <ChevronRightIcon className="size-5 shrink-0 text-muted-foreground" />
              </button>
            )}
          </Group>
        </div>
      </PopupContent>
    </Popup>
  )
}

/**
 * One server's own sheet: Config, where its block is shown and saved, and Tools, where what it offers
 * is listed. Each tab exists only where the Host advertises the read behind it, so a Host that can't
 * describe a block offers no Config tab rather than an empty one.
 */
function ServerSheet({
  profile,
  server,
  open,
  onOpenChange,
  config,
  tools,
  removable,
  saveConfig,
  onRemove,
}: {
  profile: McpServerConfig
  server: McpServer
  open: boolean
  onOpenChange: (open: boolean) => void
  config: boolean
  tools: boolean
  removable: boolean
  saveConfig: (name: string, edit: McpServerEdit) => Promise<void>
  onRemove: () => void
}) {
  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent initialFocus={false} fixedHeight={SERVER_HEIGHT}>
        <PopupHeader>
          <PopupTitle>{server.name}</PopupTitle>
        </PopupHeader>
        <Tabs defaultValue={config ? "config" : "tools"} className="min-h-0 flex-1">
          <TabsList>
            {config && <TabsTrigger value="config">Config</TabsTrigger>}
            {tools && <TabsTrigger value="tools">Tools</TabsTrigger>}
          </TabsList>
          {config && (
            <TabsContent value="config" className="flex-1 overflow-y-auto">
              <ConfigTab
                profile={profile}
                server={server}
                saveConfig={saveConfig}
                removable={removable}
                onRemove={onRemove}
              />
            </TabsContent>
          )}
          {tools && (
            <TabsContent value="tools" className="flex-1 overflow-y-auto">
              <ToolsTab profile={profile} server={server} />
            </TabsContent>
          )}
        </Tabs>
      </PopupContent>
    </Popup>
  )
}

/**
 * One server's block: the transport it runs, how it authenticates, and one field per environment
 * value with what the Host knows about it — never its content, only whether it holds one.
 *
 * A field is titled with the name the value lands under on the Host and says nothing else: a block
 * carries no prose, and a catalogue entry of the same name describes someone else's variable. A value the bot already holds
 * stands empty with Set as its placeholder: typing into it replaces what it holds, and leaving it
 * alone sends nothing. Everything is drafted in this component's own state and written by one Save —
 * a config write and a reconcile per keystroke would be a rewrite per character.
 */
function ConfigTab({
  profile,
  server,
  saveConfig,
  removable,
  onRemove,
}: {
  profile: McpServerConfig
  server: McpServer
  saveConfig: (name: string, edit: McpServerEdit) => Promise<void>
  removable: boolean
  onRemove: () => void
}) {
  const { detail, failed, reload } = useMcpServerDetail(profile, server.name, true)
  const [draft, setDraft] = useState<ConfigDraft | undefined>(undefined)
  const [rows, setRows] = useState<ValueDraft[]>([])
  const [saving, setSaving] = useState(false)
  // The answer this component's fields were built from: a read, or a save's re-read, that is newer
  // than it is the one the fields take — during render, so no frame shows the old block's fields.
  const [seeded, setSeeded] = useState<McpServerDetail | undefined>(undefined)
  if (detail && detail !== seeded) {
    setSeeded(detail)
    setDraft(configDraft(detail))
    setRows(detail.values.map((value) => ({ name: value.name, value: "" })))
  }

  if (failed && !detail) {
    return (
      <div className="flex flex-col gap-4 px-4 py-4">
        <p className="text-sm text-muted-foreground">Couldn't load this server's configuration.</p>
        <Button variant="outline" className="h-11 rounded-full" onClick={reload}>
          Try again
        </Button>
      </div>
    )
  }
  if (!detail || !draft) return null

  // Narrowed once, so the callbacks below read the block the screen is showing rather than a value
  // that could have arrived again since.
  const block: McpServerDetail = detail
  const editable = block.editable
  const canSave = editable && configChanged(block, draft, rows) && transportReady(draft)

  async function save() {
    if (!draft) return
    setSaving(true)
    try {
      await saveConfig(block.name, configEdit(draft, rows))
      // What was typed leaves the fields with the write: the re-read is what says the bot now holds
      // it, and Save has nothing left to send until something changes again.
      setRows((current) => current.map((row) => ({ ...row, value: "" })))
      reload()
      toast.success("Saved.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save that.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <FieldGroup>
        <Field>
          <FieldLabel>Transport</FieldLabel>
          <Segmented
            label="Transport"
            value={draft.transport}
            disabled={!editable}
            options={[
              { value: "http", label: "HTTP" },
              { value: "stdio", label: "stdio" },
            ]}
            onChange={(transport) => setDraft({ ...draft, transport })}
          />
        </Field>

        {draft.transport === "http" ? (
          <>
            <Field>
              <FieldLabel htmlFor="mcp-config-url">Address</FieldLabel>
              <Input
                id="mcp-config-url"
                className="h-11 font-mono text-sm"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="https://example.com/mcp"
                value={draft.url}
                disabled={!editable}
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel>Authentication</FieldLabel>
              <Segmented
                label="Authentication"
                value={draft.auth}
                disabled={!editable}
                options={[
                  { value: "none", label: "None" },
                  { value: "header", label: "Header" },
                  { value: "oauth", label: "OAuth" },
                ]}
                onChange={(auth) => setDraft({ ...draft, auth })}
              />
            </Field>
            {draft.auth === "header" && (
              <Field>
                <FieldLabel htmlFor="mcp-config-token">Token</FieldLabel>
                <Input
                  id="mcp-config-token"
                  className="h-11 font-mono text-sm"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={detail.auth === "header" ? SET_PLACEHOLDER : undefined}
                  value={draft.token}
                  disabled={!editable}
                  onChange={(event) => setDraft({ ...draft, token: event.target.value })}
                />
              </Field>
            )}
          </>
        ) : (
          <>
            <Field>
              <FieldLabel htmlFor="mcp-config-command">Command</FieldLabel>
              <Input
                id="mcp-config-command"
                className="h-11 font-mono text-sm"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="npx"
                value={draft.command}
                disabled={!editable}
                onChange={(event) => setDraft({ ...draft, command: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="mcp-config-args">Arguments</FieldLabel>
              <Input
                id="mcp-config-args"
                className="h-11 font-mono text-sm"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="-y @modelcontextprotocol/server-github"
                value={draft.args}
                disabled={!editable}
                onChange={(event) => setDraft({ ...draft, args: event.target.value })}
              />
            </Field>
          </>
        )}
      </FieldGroup>

      {(rows.length > 0 || editable) && (
        <section className="flex flex-col gap-2" data-mcp-section="values">
          <h2 className="text-sm leading-snug font-medium">Environment variables</h2>
          {rows.length > 0 && (
            <FieldGroup>
              {rows.map((row, index) => {
                const known = detail.values.find((value) => value.name === row.name)
                // The name is the whole of a row the block holds — nothing describes a value here,
                // so there is no second line — while a row the form added types its own.
                return (
                  <Field key={`${row.name}-${index}`} data-value={row.name}>
                    {row.named ? (
                      <Input
                        aria-label="Name"
                        className="h-11 font-mono text-sm"
                        autoComplete="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        placeholder="NAME"
                        value={row.name}
                        disabled={!editable}
                        onChange={(event) =>
                          setRows((current) =>
                            current.map((item, at) =>
                              at === index ? { ...item, name: event.target.value } : item,
                            ),
                          )
                        }
                      />
                    ) : (
                      <FieldLabel
                        htmlFor={`mcp-config-value-${index}`}
                        className="text-sm font-medium text-muted-foreground"
                      >
                        {row.name || known?.name}
                      </FieldLabel>
                    )}
                    <Input
                      id={`mcp-config-value-${index}`}
                      className="h-11"
                      type="password"
                      autoComplete="off"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder={known?.set ? SET_PLACEHOLDER : undefined}
                      value={row.value}
                      disabled={!editable}
                      onChange={(event) =>
                        setRows((current) =>
                          current.map((item, at) =>
                            at === index ? { ...item, value: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </Field>
                )
              })}
            </FieldGroup>
          )}
          {editable && (
            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-full"
              onClick={() =>
                setRows((current) => [...current, { name: "", value: "", named: true }])
              }
            >
              <PlusIcon data-icon="inline-start" />
              Add a value
            </Button>
          )}
        </section>
      )}

      {editable && (
        <div className="flex flex-col gap-3">
          <Button
            size="lg"
            className="h-11 rounded-full"
            disabled={!canSave || saving}
            onClick={() => void save()}
          >
            {saving && <Spinner />}
            Save
          </Button>
        </div>
      )}

      {editable && removable && (
        <Button
          type="button"
          variant="ghost"
          className="h-11 rounded-full text-destructive"
          onClick={onRemove}
        >
          <Trash2Icon data-icon="inline-start" />
          Remove server
        </Button>
      )}
    </div>
  )
}

/**
 * What one server offers, from Hermes's own schema cache — a read that connects nothing — and the
 * Load tools tap that asks the server itself when the cache has nothing or someone wants it fresh.
 * The Host connects that one server, lists what it offers and disconnects, which is why it is a tap
 * and not something the sheet does on opening.
 */
function ToolsTab({ profile, server }: { profile: McpServerConfig; server: McpServer }) {
  const { tools, probing, failed, probe } = useMcpServerTools(profile, server.name, true)
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      {tools !== undefined && tools.tools.length > 0 && (
        <Group>
          {tools.tools.map((tool) => (
            <div key={tool.name} className={rowClass} data-tool={tool.name}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-sm">{tool.name}</span>
                {tool.description && (
                  <span className="line-clamp-3 text-sm text-muted-foreground">
                    {tool.description}
                  </span>
                )}
              </span>
            </div>
          ))}
        </Group>
      )}
      {failed && <p className="text-sm text-destructive">{failed}</p>}
      <Button
        type="button"
        variant={tools?.tools.length ? "outline" : "default"}
        className="h-11 rounded-full"
        disabled={probing}
        onClick={() => void probe()}
      >
        {probing && <Spinner />}
        Load tools
      </Button>
    </div>
  )
}

/**
 * Hermes's Catalogue as the Bot's Host offers it: the entries this Bot doesn't have, searched over
 * both their names and what Hermes says each one is. A tap adds it — at once where the entry declares
 * nothing to fill in, and through its form where it does — so the entry that needs nothing from the
 * user takes nothing from them (ADR 0014).
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
  // The entry whose form is open, by name: one at a time, stacked above the list it was picked from.
  const [picking, setPicking] = useState<string | undefined>(undefined)
  const [installing, setInstalling] = useState<string | undefined>(undefined)
  const shown =
    entries === undefined
      ? undefined
      : searchCatalogue(
          entries.filter((entry) => !entry.installed),
          query,
        )

  async function add(entry: McpCatalogueEntry) {
    if (entry.needsConfig) {
      setPicking(entry.name)
      return
    }
    setInstalling(entry.name)
    try {
      await install(entry.name, {})
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't add that.")
    } finally {
      setInstalling(undefined)
    }
  }

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
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 pt-2 pb-4">
          <ItemSearch value={query} onChange={setQuery} label="Search the catalogue" />
          {shown === undefined ? null : shown.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">
              {query.trim() ? `Nothing matches “${query.trim()}”.` : "Nothing left to add."}
            </p>
          ) : (
            <Group>
              {shown.map((entry) => (
                <CatalogueRow
                  key={entry.name}
                  entry={entry}
                  installing={installing === entry.name}
                  disabled={installing !== undefined}
                  onOpen={() => void add(entry)}
                />
              ))}
            </Group>
          )}
        </div>
        {/* One entry's form: a sheet stacked on this one, dismissed back to the Catalogue. It renders
            inside this sheet's tree so Base UI keeps the nesting. */}
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

/** One Catalogue entry: what Hermes calls it and what it is; a tap adds it, or opens its form. */
function CatalogueRow({
  entry,
  installing,
  disabled,
  onOpen,
}: {
  entry: McpCatalogueEntry
  installing: boolean
  disabled: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      className={linkRowClass}
      data-catalogue={entry.name}
      disabled={disabled}
      onClick={onOpen}
    >
      <ServerIcon className="size-5 shrink-0 text-muted-foreground" />
      <RowText title={entry.name} subtitle={entry.description || undefined} />
      {installing ? (
        <Spinner />
      ) : (
        <ChevronRightIcon className="size-5 shrink-0 text-muted-foreground" />
      )}
    </button>
  )
}

/**
 * One Catalogue entry's form: a field per value the entry declares, and the Add that writes them.
 *
 * A field is titled with the name the value lands under on the Host and subtitled with the prompt the
 * entry writes for people, where that says anything the name doesn't; a secret's is masked and a
 * required one is starred. A required field left empty (or a space or two, which is nothing typed in)
 * refuses the add and marks that field, and a value the Bot already holds has a field of its own,
 * standing empty and saying so. Adding closes the form and the Catalogue behind it, and what the
 * screen's list becomes is the Host's own answer.
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
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 pt-2 pb-4">
        {/* A read that came back an error: said, rather than left as a form with nothing in it. */}
        {failed && entry === undefined && (
          <p className="px-1 text-sm text-muted-foreground">Couldn't load this entry's values.</p>
        )}
        <FieldGroup>
          {entry?.values.map((value) => (
            <Field key={value.name} data-value={value.name} data-required={value.required}>
              {/* Hermes names a value twice: the name it lands under on the Host, and the prompt its
                  manifest writes for people. The name is the title — it is what the field becomes —
                  and the prompt is the subtext. */}
              <FieldLabel
                htmlFor={`mcp-value-${value.name}`}
                className="flex-col items-start gap-0.5"
              >
                <span className="font-mono text-sm">
                  {value.name}
                  {value.required && <span aria-hidden="true">{" *"}</span>}
                </span>
                {value.prompt && value.prompt !== value.name && (
                  <span className="text-xs font-normal text-muted-foreground">{value.prompt}</span>
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
                onChange={(event) => {
                  const given = event.target.value
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
          {adding && <Spinner />}
          Add
        </Button>
      </div>
    </>
  )
}

/**
 * A server typed in by hand: a name, one transport and what it needs — a URL with how it
 * authenticates, or a command with its arguments and environment values. It is Hermes's own create
 * contract, and the Host has the last word on it: a name the bot already has, one a plugin provides
 * and a configuration its validator won't take each come back refused, in its own words.
 */
function CustomServerSheet({
  open,
  onOpenChange,
  add,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  add: (server: McpCustomServer) => Promise<void>
}) {
  const blank: ConfigDraft = {
    transport: "http",
    url: "",
    command: "",
    args: "",
    auth: "none",
    token: "",
  }
  const [name, setName] = useState("")
  const [draft, setDraft] = useState<ConfigDraft>(blank)
  const [rows, setRows] = useState<ValueDraft[]>([])
  const [adding, setAdding] = useState(false)

  // The form is blank the next time it opens, whether it was closed or the add closed it.
  function reset() {
    setName("")
    setDraft(blank)
    setRows([])
  }

  async function save() {
    setAdding(true)
    try {
      await add(customServer(name, draft, rows))
      reset()
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't add that.")
    } finally {
      setAdding(false)
    }
  }

  return (
    <Popup
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <PopupContent initialFocus={false} fixedHeight={SERVER_HEIGHT}>
        <PopupHeader>
          <PopupTitle>Custom server</PopupTitle>
        </PopupHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="mcp-custom-name">Name</FieldLabel>
              <Input
                id="mcp-custom-name"
                className="h-11 font-mono text-sm"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>Transport</FieldLabel>
              <Segmented
                label="Transport"
                value={draft.transport}
                options={[
                  { value: "http", label: "HTTP" },
                  { value: "stdio", label: "stdio" },
                ]}
                onChange={(transport) => setDraft({ ...draft, transport })}
              />
            </Field>

            {draft.transport === "http" ? (
              <>
                <Field>
                  <FieldLabel htmlFor="mcp-custom-url">Address</FieldLabel>
                  <Input
                    id="mcp-custom-url"
                    className="h-11 font-mono text-sm"
                    inputMode="url"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="https://example.com/mcp"
                    value={draft.url}
                    onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel>Authentication</FieldLabel>
                  <Segmented
                    label="Authentication"
                    value={draft.auth}
                    options={[
                      { value: "none", label: "None" },
                      { value: "header", label: "Header" },
                      { value: "oauth", label: "OAuth" },
                    ]}
                    onChange={(auth) => setDraft({ ...draft, auth })}
                  />
                </Field>
                {draft.auth === "header" && (
                  <Field>
                    <FieldLabel htmlFor="mcp-custom-token">Token</FieldLabel>
                    <Input
                      id="mcp-custom-token"
                      className="h-11 font-mono text-sm"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={draft.token}
                      onChange={(event) => setDraft({ ...draft, token: event.target.value })}
                    />
                  </Field>
                )}
              </>
            ) : (
              <>
                <Field>
                  <FieldLabel htmlFor="mcp-custom-command">Command</FieldLabel>
                  <Input
                    id="mcp-custom-command"
                    className="h-11 font-mono text-sm"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="npx"
                    value={draft.command}
                    onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="mcp-custom-args">Arguments</FieldLabel>
                  <Input
                    id="mcp-custom-args"
                    className="h-11 font-mono text-sm"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="-y @modelcontextprotocol/server-github"
                    value={draft.args}
                    onChange={(event) => setDraft({ ...draft, args: event.target.value })}
                  />
                </Field>
              </>
            )}
          </FieldGroup>

          {draft.transport === "stdio" && (
            <section className="flex flex-col gap-2" data-mcp-section="values">
              <h2 className="text-sm leading-snug font-medium">Environment variables</h2>
              {rows.length > 0 && (
                <FieldGroup>
                  {rows.map((row, index) => (
                    <Field key={index} data-value={row.name}>
                      <div className="flex items-center gap-2">
                        <Input
                          id={`mcp-custom-value-name-${index}`}
                          aria-label="Name"
                          className="h-11 min-w-0 flex-1 font-mono text-sm"
                          autoComplete="off"
                          autoCapitalize="off"
                          spellCheck={false}
                          placeholder="TOKEN"
                          value={row.name}
                          onChange={(event) =>
                            setRows((current) =>
                              current.map((item, at) =>
                                at === index ? { ...item, name: event.target.value } : item,
                              ),
                            )
                          }
                        />
                        <Input
                          id={`mcp-custom-value-${index}`}
                          aria-label="Value"
                          className="h-11 min-w-0 flex-1"
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          value={row.value}
                          onChange={(event) =>
                            setRows((current) =>
                              current.map((item, at) =>
                                at === index ? { ...item, value: event.target.value } : item,
                              ),
                            )
                          }
                        />
                      </div>
                    </Field>
                  ))}
                </FieldGroup>
              )}
              <Button
                type="button"
                variant="outline"
                className="h-11 rounded-full"
                onClick={() => setRows((current) => [...current, { name: "", value: "" }])}
              >
                <PlusIcon data-icon="inline-start" />
                Add a value
              </Button>
            </section>
          )}

          <Button
            size="lg"
            className="h-11 rounded-full"
            disabled={!customReady(name, draft) || adding}
            onClick={() => void save()}
          >
            {adding && <Spinner />}
            Add
          </Button>
        </div>
      </PopupContent>
    </Popup>
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
