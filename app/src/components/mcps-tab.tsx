import { useEffect, useState } from "react"
import { useNavigate } from "react-router"
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
import {
  Caption,
  Group,
  linkRowClass,
  rowClass,
  RowText,
  useHeaderAction,
} from "@/components/settings-chrome"
import { useCopied } from "@/lib/copied"
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
import { Segmented } from "@/components/segmented"
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
  BLANK_DRAFT,
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
  McpServerValue,
} from "@/lib/hermes"
import { cn } from "@/lib/utils"
import { botSubPath, type BotSub } from "@/lib/bot-subs"
import { botTabPath } from "@/lib/bot-tabs"

/** How tall the sheet holding the Catalogue is, so it holds its two views the way the picker does. */
const CATALOGUE_HEIGHT = "h-[min(32rem,85dvh)]"

/** How tall the custom form's sheet is, so its fields hold their place as values are added to it. */
const SERVER_HEIGHT = "h-[min(34rem,85dvh)]"

/**
 * What a field for a value the Bot already holds says: the Host reports that it has one and never its
 * content, so the field stands empty with this as its placeholder, and typing over it replaces it.
 */
const SET_PLACEHOLDER = "Set — type to replace"

/**
 * A bot's MCP servers, as a page of its Settings: a + in the screen's header adds one, then the
 * servers the bot's own configuration holds, then the ones a Hermes plugin provides — each list
 * captioned rather than headed (ADR 0055).
 *
 * Every row is its name over its health — *Healthy: 78 tools* where Hermes reports a count, the
 * Host's own sentence where it failed, *Click here to authenticate* where
 * Server access is what stands in the way — and that health line is the button starting the flow, so
 * the waiting row and the way out of it are one line. Tapping the name drills into the server's own
 * page: Config, where its block is shown and saved, and Tools, where what it offers is listed
 * (ADR 0014), at the address `botSubPath(profile.id, "mcps", server.name)`.
 *
 * A caption with nothing under it is left out, so a bot with no servers shows its lists alone and the
 * + over them. Each way in is offered under its own feature: the Catalogue where the Host can browse
 * it, the custom form where it can land a block at all — a Host may have one and not the other, and a
 * Host with neither gets no +.
 */
export function McpsTab({ profile, sub }: { profile: Profile; sub?: BotSub }) {
  const answers = useMcpFeatureAnswers(profile)
  const navigate = useNavigate()
  // Which sheet is open. They exclude each other — the Catalogue replaces the Add choice, its removal
  // stands over the page it was offered from — so one state says what the screen is showing rather
  // than six booleans that have to be kept in agreement.
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const granting = sheet?.kind === "access" ? sheet.name : null
  // While the access sheet waits, the screen keeps reading, so the wait sees the access land on a
  // row whose own state would never move it.
  const { servers, setEnabled, remove, saveConfig, addCustom, install, grant, deliver, reload } =
    useMcpServers(profile, answers.list === "yes", granting !== null)
  const [busy, setBusy] = useState(false)
  // The server this address drills into. Its name is the segment's, so a server the Host has stopped
  // listing still opens as the address it was given, saying the bot no longer has it.
  const detail = sub?.kind === "detail" ? sub : undefined
  const grantingServer =
    sheet?.kind === "access" ? servers?.find((server) => server.name === sheet.name) : undefined
  const mine = servers?.filter((server) => server.source === "config") ?? []
  const theirs = servers?.filter((server) => server.source === "plugin") ?? []
  // A server only opens where the Host advertises a tab behind it, so a row whose name could show
  // nothing keeps its name plain.
  const openable = answers.config === "yes" || answers.tools === "yes"
  // The way in is the screen header's +, which exists only while this page is the one on screen.
  // Its handler is the sheet's state setter — stable across renders — so the header drawing it from
  // a ref never has to follow the page's own renders. The gate is the Add row's own: a Host without
  // `mcps_add` has nothing to offer behind it, and a server's own page offers nothing either.
  useHeaderAction(
    // A server's own page carries no +. The key changes with it, because the header reads the slot
    // once per key: the page it replaced would otherwise keep the node it published a moment before.
    detail ? "mcp-add-detail" : "mcp-add",
    answers.add === "yes" && !detail ? (
      <Button
        variant="outline"
        size="icon-lg"
        className="size-11 rounded-full"
        aria-label="Add a server"
        title="Add a server"
        data-mcp-add
        onClick={() => setSheet({ kind: "add" })}
      >
        <PlusIcon />
      </Button>
    ) : null,
  )

  async function confirmRemove(name: string) {
    setBusy(true)
    try {
      await remove(name)
      setSheet(null)
      // Removed from its own page, the address names a server the Host no longer lists: the screen
      // goes back to the page it was opened from rather than reporting it gone.
      if (detail) navigate(botTabPath(profile.id, "mcps"), { replace: true })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't remove that.")
    } finally {
      setBusy(false)
    }
  }

  // Nothing is drawn until the Host has answered that it lists servers: the tab only exists for a
  // Host that does, so a blank frame here is the tab arriving rather than a bot without one.
  if (answers.list !== "yes") return null

  // A detail takes the page's place at every width: below 1024px the route pushed it, and from
  // 1024px it is the pane the page would have drawn in.
  if (detail)
    return (
      <div className="flex flex-col gap-4" data-mcp-tab data-mcp-detail={detail.title}>
        <ServerDetail
          profile={profile}
          name={detail.title}
          servers={servers}
          config={answers.config === "yes"}
          tools={answers.tools === "yes"}
          removable={answers.removable === "yes"}
          saveConfig={saveConfig}
          onRemove={() => setSheet({ kind: "remove", name: detail.title })}
        />
        <RemoveDialog
          name={sheet?.kind === "remove" ? sheet.name : undefined}
          busy={busy}
          onCancel={() => setSheet(null)}
          onConfirm={(name) => void confirmRemove(name)}
        />
      </div>
    )

  return (
    <div className="flex flex-col gap-4" data-mcp-tab>
      <ServerSection
        title="Your servers"
        section="config"
        servers={mine}
        onOpen={openable ? (name) => navigate(botSubPath(profile.id, "mcps", name)) : undefined}
        controls={{
          writable: answers.write === "yes",
          access: answers.access === "yes",
          onToggle: setEnabled,
          onGrant: (name) => setSheet({ kind: "access", name }),
        }}
      />

      <ServerSection
        title="From plugins"
        section="plugin"
        servers={theirs}
        onOpen={openable ? (name) => navigate(botSubPath(profile.id, "mcps", name)) : undefined}
      />

      <AddServerSheet
        open={sheet?.kind === "add"}
        onOpenChange={(next) => setSheet(next ? { kind: "add" } : null)}
        onCatalogue={() => setSheet({ kind: "catalogue" })}
        onCustom={() => setSheet({ kind: "custom" })}
        catalogue={answers.catalogue === "yes"}
        custom={answers.add === "yes"}
      />

      <McpCatalogueSheet
        open={sheet?.kind === "catalogue"}
        onOpenChange={(next) => setSheet(next ? { kind: "catalogue" } : null)}
        profile={profile}
        install={install}
      />

      <CustomServerSheet
        open={sheet?.kind === "custom"}
        onOpenChange={(next) => setSheet(next ? { kind: "custom" } : null)}
        add={addCustom}
      />

      {/* The flow is the Host's: the sheet starts it, shows the URL to open in a browser, and takes
          the address that browser ended on when it ran on this phone instead. */}
      {grantingServer && (
        <ServerAccessSheet
          server={grantingServer}
          open
          onOpenChange={(next) => !next && setSheet(null)}
          grant={grant}
          deliver={deliver}
          reload={reload}
        />
      )}

      <RemoveDialog
        name={sheet?.kind === "remove" ? sheet.name : undefined}
        busy={busy}
        onCancel={() => setSheet(null)}
        onConfirm={(name) => void confirmRemove(name)}
      />
    </div>
  )
}

/** Which sheet the screen is showing: exactly one, or none. */
type Sheet =
  | { kind: "add" }
  | { kind: "catalogue" }
  | { kind: "custom" }
  | { kind: "access"; name: string }
  | { kind: "remove"; name: string }

/**
 * Taking a server away, asked over whatever offered it — the page or the server's own page — and
 * dismissed back to it. Cancelling writes nothing, and the removal is the page's own write.
 */
function RemoveDialog({
  name,
  busy,
  onCancel,
  onConfirm,
}: {
  /** The server being removed, or nothing where the question isn't up. */
  name?: string
  busy: boolean
  onCancel: () => void
  onConfirm: (name: string) => void
}) {
  return (
    <AlertDialog
      open={Boolean(name)}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel()
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {name ?? ""}?</AlertDialogTitle>
          <AlertDialogDescription>
            The bot stops having it, and its stored access goes with it. The values you gave it stay
            on the host, so adding it again doesn't mean finding them twice.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={() => name && onConfirm(name)}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * What a row of *Your servers* can do: the switch, the sheet and the access flow. A plugin's rows get
 * none of it, because Hermes refuses to modify what a plugin provides (ADR 0014).
 */
type RowControls = {
  /** Whether the Host can write this bot's config, so a row may offer its switch. */
  writable: boolean
  /** Whether the Host can start Server access, so a health line may be the tap. */
  access: boolean
  onToggle: (name: string, enabled: boolean) => Promise<void>
  onGrant: (name: string) => void
}

/**
 * One of the screen's two lists: a caption over the card holding it, with nothing at all when the
 * list is empty — a caption over no rows says there are none, and the screen drops it instead.
 */
function ServerSection({
  title,
  section,
  servers,
  onOpen,
  controls,
}: {
  title: string
  section: string
  servers: McpServer[]
  /** Drilling into a server's own page, where the Host can show one: every row of both lists has it. */
  onOpen?: (name: string) => void
  controls?: RowControls
}) {
  if (servers.length === 0) return null
  return (
    <section className="flex flex-col gap-2" data-mcp-section={section}>
      <Caption>{title}</Caption>
      <Group>
        {servers.map((server) => (
          <ServerRow key={server.name} server={server} onOpen={onOpen} controls={controls} />
        ))}
      </Group>
    </section>
  )
}

/**
 * One server: its name, its health, and the switch its Host advertises.
 *
 * The name is the button drilling into the server's own page, and the health line sits under it — a
 * button of its own where it is the way to start Server access, plain text everywhere else. The
 * switch follows the server's own on/off flag rather than its state word, which folds several of the
 * Host's states into "on", and it is the only control a row carries: removing a server lives in its
 * Config tab with the rest of what changes it.
 */
function ServerRow({
  server,
  onOpen,
  controls,
}: {
  server: McpServer
  onOpen?: (name: string) => void
  controls?: RowControls
}) {
  const [saving, setSaving] = useState(false)
  // A row offers the flow where the Host can start one and this server is one it can start it for.
  const line = healthLine(server, {
    canAuthenticate: offersAccess(controls?.access === true, server.access),
  })
  // A server a Hermes plugin provides is read-only, and so is every row of a Host that can't write,
  // so no switch is offered where one could only come back refused.
  const editable = server.source === "config" && controls?.writable === true
  return (
    <div className={rowClass} data-mcp={server.name}>
      <ServerIcon className="size-5 shrink-0 text-muted-foreground" />
      <RowText
        title={
          onOpen ? (
            <button
              type="button"
              className="max-w-full truncate rounded-lg text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onOpen(server.name)}
            >
              {server.name}
            </button>
          ) : (
            server.name
          )
        }
        subtitle={
          line.authenticate && controls ? (
            // A failure the Host says access can fix stays a failure to read, so its colour comes
            // from that rather than from the line being tappable. The line reads exactly where a
            // plain subtitle would — the target grows below the text rather than around it, so
            // nothing overlaps the row beneath, whose switch is a tap of its own.
            <button
              type="button"
              className={cn(
                "-mx-1 flex min-h-11 items-start px-1 pt-0 pb-3 text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
                line.failed ? "text-destructive" : "text-warning",
              )}
              onClick={() => controls.onGrant(server.name)}
            >
              {line.text}
            </button>
          ) : (
            <span className={line.failed ? "text-destructive" : undefined}>{line.text}</span>
          )
        }
      />
      {editable && controls && (
        <Switch
          aria-label={`${server.name} on`}
          checked={server.enabled}
          disabled={saving}
          onCheckedChange={async (checked) => {
            setSaving(true)
            try {
              await controls.onToggle(server.name, checked)
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

/**
 * One server's own page: Config, where its block is shown and saved, and Tools, where what it offers
 * is listed, under the server's name. Each tab exists only where the Host advertises the read behind
 * it, so a Host that can't describe a block offers no Config tab rather than an empty one. It is a
 * drill-in, not a sheet: the route's screen draws the header and the way back, so nothing here wears
 * a title bar or a drag handle.
 *
 * A server the Host no longer lists — an address opened after it was removed elsewhere — says so,
 * and the screen's own back is the way out.
 */
function ServerDetail({
  profile,
  name,
  servers,
  config,
  tools,
  removable,
  saveConfig,
  onRemove,
}: {
  profile: McpServerConfig
  /** The server the address names: its name, whatever the Host lists. */
  name: string
  /** What the Host lists, or nothing while it is still reading it. */
  servers: McpServer[] | undefined
  config: boolean
  tools: boolean
  removable: boolean
  saveConfig: (name: string, edit: McpServerEdit) => Promise<McpServerDetail | undefined>
  onRemove: () => void
}) {
  // Still reading the bot's servers: nothing to say either way yet.
  if (servers === undefined) return null
  const server = servers.find((one) => one.name === name)
  if (!server)
    return (
      <p className="text-sm text-muted-foreground" data-mcp-gone={name}>
        This bot doesn't have this server any more.
      </p>
    )
  return (
    <div className="flex flex-col gap-4" data-mcp-server={server.name}>
      {/* The screen's title lives in the header above the pane; the content leads with the tabs. */}
      <Tabs defaultValue={config ? "config" : "tools"} className="gap-2">
        <TabsList>
          {config && <TabsTrigger value="config">Config</TabsTrigger>}
          {tools && <TabsTrigger value="tools">Tools</TabsTrigger>}
        </TabsList>
        {config && (
          // Both panels stay mounted: a switch between them must not throw away a half-typed value
          // or read the Host again for a block it already has.
          <TabsContent value="config" keepMounted>
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
          <TabsContent value="tools" keepMounted>
            <ToolsTab profile={profile} server={server} />
          </TabsContent>
        )}
      </Tabs>
      {/* Removal is advertised on its own gate, so a Host that can remove a server without being
          able to describe one still gets the way to do it — the Config tab is where it sits when
          there is one, since that is the tab a removal belongs to. */}
      {!config && removable && server.source !== "plugin" && <RemoveServer onRemove={onRemove} />}
    </div>
  )
}

/** A server's transport and the fields it needs, shared by its Config tab and the custom form.
 *
 * Both edit the same block — an address or a command, an authentication kind and the token, the
 * arguments — so one component keeps the two forms from drifting apart, and the id prefix is the
 * only thing that differs (`mcp-config` and `mcp-custom` are what the flows find their fields by).
 */
function ServerFields({
  id,
  draft,
  onChange,
  editable = true,
  tokenSet = false,
}: {
  id: string
  draft: ConfigDraft
  onChange: (draft: ConfigDraft) => void
  editable?: boolean
  tokenSet?: boolean
}) {
  const field = "h-11 font-mono text-sm"

  return (
    <FieldGroup>
      <Field>
        <FieldLabel>Transport</FieldLabel>
        <Segmented
          label="Transport"
          value={draft.transport}
          disabled={!editable}
          options={[
            { id: "http", label: "HTTP" },
            { id: "stdio", label: "stdio" },
          ]}
          onChange={(transport) => onChange({ ...draft, transport })}
        />
      </Field>

      {draft.transport === "http" ? (
        <>
          <Field>
            <FieldLabel htmlFor={`${id}-url`}>Address</FieldLabel>
            <Input
              id={`${id}-url`}
              className={field}
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://example.com/mcp"
              value={draft.url}
              disabled={!editable}
              onChange={(event) => onChange({ ...draft, url: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel>Authentication</FieldLabel>
            <Segmented
              label="Authentication"
              value={draft.auth}
              disabled={!editable}
              options={[
                { id: "none", label: "None" },
                { id: "header", label: "Header" },
                { id: "oauth", label: "OAuth" },
              ]}
              onChange={(auth) => onChange({ ...draft, auth })}
            />
          </Field>
          {draft.auth === "header" && (
            <Field>
              <FieldLabel htmlFor={`${id}-token`}>Token</FieldLabel>
              <Input
                id={`${id}-token`}
                className={field}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={tokenSet ? SET_PLACEHOLDER : undefined}
                value={draft.token}
                disabled={!editable}
                onChange={(event) => onChange({ ...draft, token: event.target.value })}
              />
            </Field>
          )}
        </>
      ) : (
        <>
          <Field>
            <FieldLabel htmlFor={`${id}-command`}>Command</FieldLabel>
            <Input
              id={`${id}-command`}
              className={field}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="npx"
              value={draft.command}
              disabled={!editable}
              onChange={(event) => onChange({ ...draft, command: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-args`}>Arguments</FieldLabel>
            <Input
              id={`${id}-args`}
              className={field}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="-y @modelcontextprotocol/server-github"
              value={draft.args}
              disabled={!editable}
              onChange={(event) => onChange({ ...draft, args: event.target.value })}
            />
          </Field>
        </>
      )}
    </FieldGroup>
  )
}

/** The environment values under their heading, with Add a value beneath them.
 *
 * A row is its environment name and nothing else: the name a block holds is the row's title, and a
 * row the form is adding types its own above the value. Neither form describes a value — the block
 * carries no prose — and a value the bot holds is never sent back, so its field stands empty with
 * Set as the placeholder.
 */
function ValueSection({
  id,
  rows,
  known,
  editable = true,
  onChange,
}: {
  id: string
  rows: ValueDraft[]
  known: McpServerValue[]
  editable?: boolean
  onChange: (rows: ValueDraft[]) => void
}) {
  const update = (index: number, patch: Partial<ValueDraft>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)))
  const held = (name: string) => Boolean(known.find((value) => value.name === name)?.set)

  return (
    <section className="flex flex-col gap-2" data-mcp-section="values">
      <h2 className="text-sm leading-snug font-medium">Environment variables</h2>
      {rows.length > 0 && (
        <FieldGroup>
          {rows.map((row, index) => (
            <Field key={index} data-value={row.name}>
              {row.named ? (
                <Input
                  id={`${id}-value-name-${index}`}
                  aria-label="Name"
                  className="h-11 text-sm"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder="NAME"
                  value={row.name}
                  disabled={!editable}
                  onChange={(event) => update(index, { name: event.target.value })}
                />
              ) : (
                <FieldLabel
                  htmlFor={`${id}-value-${index}`}
                  className="text-sm font-medium text-muted-foreground"
                >
                  {row.name}
                </FieldLabel>
              )}
              <Input
                id={`${id}-value-${index}`}
                className="h-11"
                type="password"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder={held(row.name) ? SET_PLACEHOLDER : undefined}
                value={row.value}
                disabled={!editable}
                onChange={(event) => update(index, { value: event.target.value })}
              />
            </Field>
          ))}
        </FieldGroup>
      )}
      {editable && (
        <Button
          type="button"
          variant="outline"
          className="h-11 rounded-full"
          onClick={() => onChange([...rows, { name: "", value: "", named: true }])}
        >
          <PlusIcon data-icon="inline-start" />
          Add a value
        </Button>
      )}
    </section>
  )
}

/**
 * One server's block: the transport it runs, how it authenticates, and one field per environment
 * value with what the Host knows about it — never its content, only whether it holds one.
 *
 * A field is titled with the name the value lands under on the Host and says nothing else: a block
 * carries no prose, and a catalogue entry of the same name describes someone else's variable. A
 * value the bot already holds stands empty with Set as its placeholder: typing into it replaces
 * what it holds, and leaving it alone sends nothing. Everything is drafted in this component's own
 * state and written by one Save — a config write and a reconcile per keystroke would be a rewrite
 * per character.
 */
function ConfigTab({
  profile,
  server,
  removable,
  onRemove,
  saveConfig,
}: {
  profile: McpServerConfig
  server: McpServer
  removable: boolean
  onRemove: () => void
  saveConfig: (name: string, edit: McpServerEdit) => Promise<McpServerDetail | undefined>
}) {
  const { detail, failed, reload } = useMcpServerDetail(profile, server.name, true)
  // What a save answered: the block as the Host landed it, which is newer than the read the sheet
  // opened with and costs no second request.
  const [written, setWritten] = useState<McpServerDetail | undefined>(undefined)
  // A save's answer can describe the same block as the read, so the form is reseeded by hand:
  // Save clears what was typed, exactly as a fresh read would.
  const [version, setVersion] = useState(0)
  const block = written ?? detail

  if (failed && !block) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">Couldn't load this server's configuration.</p>
        <Button variant="outline" className="h-11 rounded-full" onClick={reload}>
          Try again
        </Button>
      </div>
    )
  }
  if (!block) return null

  return (
    <ConfigFields
      key={`${version}:${configKey(block)}`}
      block={block}
      removable={removable}
      onRemove={onRemove}
      saveConfig={saveConfig}
      onSaved={(saved) => {
        setWritten(saved)
        setVersion((count) => count + 1)
      }}
    />
  )
}

/**
 * The block's own identity, as the form is keyed on it: a read that lands a different block
 * reseeds every field from it, so nothing here has to watch for one arriving mid-edit.
 */
function configKey(detail: McpServerDetail): string {
  const values = detail.values.map((value) => `${value.name}:${value.set ? 1 : 0}`).join(",")
  return [
    detail.transport,
    detail.url,
    detail.command,
    detail.args.join(" "),
    detail.auth,
    values,
  ].join("|")
}

/** One server's block as its fields: the transport and its own fields, its values, and one Save. */
function ConfigFields({
  block,
  removable,
  onRemove,
  onSaved,
  saveConfig,
}: {
  block: McpServerDetail
  removable: boolean
  onRemove: () => void
  onSaved: (saved: McpServerDetail) => void
  saveConfig: (name: string, edit: McpServerEdit) => Promise<McpServerDetail | undefined>
}) {
  const [draft, setDraft] = useState(() => configDraft(block))
  const [rows, setRows] = useState<ValueDraft[]>(() =>
    block.values.map((value) => ({ name: value.name, value: "" })),
  )
  const [saving, setSaving] = useState(false)
  const editable = block.editable
  const canSave = editable && configChanged(block, draft, rows) && transportReady(draft)

  async function save() {
    setSaving(true)
    try {
      const saved = await saveConfig(block.name, configEdit(draft, rows))
      if (saved) onSaved(saved)
      else setRows((current) => current.map((row) => ({ ...row, value: "" })))
      toast.success("Saved.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save that.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 pt-2">
      <ServerFields
        id="mcp-config"
        draft={draft}
        onChange={setDraft}
        editable={editable}
        tokenSet={block.auth === "header"}
      />

      {(rows.length > 0 || editable) && (
        <ValueSection
          id="mcp-config"
          rows={rows}
          known={block.values}
          editable={editable}
          onChange={setRows}
        />
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

      {editable && removable && <RemoveServer onRemove={onRemove} />}
    </div>
  )
}

/** Taking a server away: the Config tab's last button, and its own where there is no tab. */
function RemoveServer({ onRemove }: { onRemove: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="h-11 rounded-full text-destructive"
      onClick={onRemove}
    >
      <Trash2Icon data-icon="inline-start" />
      Remove server
    </Button>
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
    <div className="flex flex-col gap-4 pt-2">
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

/** The +'s two ways in: Hermes's Catalogue, or a server typed in by hand. */
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
 * Hermes's Catalogue as the Bot's Host offers it: the entries this Bot doesn't have, searched over
 * both their names and what Hermes says each one is. A tap adds it — at once where the entry declares
 * nothing to fill in, and through its form where it does — so the entry that needs nothing from the
 * user takes nothing from them (ADR 0014).
 */
function McpCatalogueSheet({
  open,
  onOpenChange,
  profile,
  install,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  profile: McpServerConfig
  install: (name: string, values: Record<string, string>) => Promise<void>
}) {
  const entries = useMcpCatalogue(profile, open)
  // What this screen added: the list a read landed is kept across opens, so without this the entry
  // just added is still in it, still reading as not installed, until the next read lands.
  const [added, setAdded] = useState<string[]>([])
  const [query, setQuery] = useState("")
  // The entry whose form is open, by name: one at a time, stacked above the list it was picked from.
  const [picking, setPicking] = useState<string | undefined>(undefined)
  const [installing, setInstalling] = useState<string | undefined>(undefined)
  const shown =
    entries === undefined
      ? undefined
      : searchCatalogue(
          entries.filter((entry) => !entry.installed && !added.includes(entry.name)),
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
      setAdded((current) => [...current, entry.name])
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
                profile={profile}
                name={picking}
                install={install}
                onBack={() => setPicking(undefined)}
                onAdded={() => {
                  setAdded((current) => [...current, picking])
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
  profile,
  name,
  install,
  onBack,
  onAdded,
}: {
  profile: McpServerConfig
  name: string
  install: (name: string, values: Record<string, string>) => Promise<void>
  onBack: () => void
  onAdded: () => void
}) {
  const { entry, failed } = useMcpCatalogueEntry(profile, name, true)
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
                <span className="text-sm">
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
  const [name, setName] = useState("")
  const [draft, setDraft] = useState<ConfigDraft>(BLANK_DRAFT)
  const [rows, setRows] = useState<ValueDraft[]>([])
  const [adding, setAdding] = useState(false)

  // The form is blank the next time it opens, whether it was closed or the add closed it.
  function reset() {
    setName("")
    setDraft(BLANK_DRAFT)
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
          </FieldGroup>

          <ServerFields id="mcp-custom" draft={draft} onChange={setDraft} />

          {draft.transport === "stdio" && (
            <ValueSection id="mcp-custom" rows={rows} known={[]} onChange={setRows} />
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
  grant: (name: string, abandoned?: AbortSignal) => Promise<McpAccess>
  deliver: (name: string, url: string) => Promise<void>
  reload: () => Promise<void>
}) {
  const [flow, setFlow] = useState<McpAccess | undefined>(undefined)
  const [starting, setStarting] = useState(false)
  const [failed, setFailed] = useState<string | undefined>(undefined)
  const [expired, setExpired] = useState(false)
  const [pasted, setPasted] = useState("")
  const [sending, setSending] = useState(false)
  const { copied, noteCopied } = useCopied()
  // Bumped by Try again: each start (and each retry) is one attempt at the flow.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    // Dismissing the sheet abandons the flow: the request goes with it rather than holding a Host
    // flow open for the rest of its timeout.
    const stopped = new AbortController()
    setFlow(undefined)
    setFailed(undefined)
    setExpired(false)
    setPasted("")
    setStarting(true)
    void (async () => {
      try {
        const answer = await grant(server.name, stopped.signal)
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
      stopped.abort()
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
      noteCopied()
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
