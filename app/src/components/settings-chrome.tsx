import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react"

import {
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  type LucideIcon,
} from "lucide-react"

import { toast } from "sonner"

import { Link } from "react-router"

import { ModelPicker } from "@/components/chat/model-picker"
import { ExperimentalBadge } from "@/components/experimental-badge"
import { ConfirmDestructive } from "@/components/confirm-destructive"
import { PickGroup, PickRow } from "@/components/pick-row"
import { SearchField } from "@/components/search-field"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import type { ModelChoice, Profile } from "@/lib/db"
import { useModelInfo } from "@/lib/model-info"
import { holdsUnsavedChanges, useUnsavedChanges } from "@/lib/unsaved"
import { cn } from "@/lib/utils"

/**
 * The slot a page fills in the header of the Screen holding it, keyed so one page's action replaces
 * another's. Each Screen provides its own, so a page beside its list never reaches the list's head.
 */
const HeaderSlot = createContext<(key: string, draw: (() => ReactNode) | null) => void>(() => {})

/**
 * The title a page names the Screen it draws under with, where the route's own can't: a screen that
 * is one of a list's rows is titled by the row it holds, and only the answer the screen reads knows
 * what that row is called. Nothing published leaves the route's title standing.
 */
const TitleSlot = createContext<(title: string | undefined) => void>(() => {})

/** The chrome every Settings screen wears: a sticky header over one centred column of groups. */
export function Screen({
  title,
  leading,
  action,
  className,
  children,
}: {
  title: string
  leading?: ReactNode
  /** A control at the header's right edge, after the title: the screen's own action. */
  action?: ReactNode
  className?: string
  children: ReactNode
}) {
  const [page, setPage] = useState<{ key: string; draw: () => ReactNode } | null>(null)
  const [named, setNamed] = useState<string>()
  const publish = useCallback((key: string, draw: (() => ReactNode) | null) => {
    setPage(draw ? { key, draw } : null)
  }, [])
  const shown = action ?? page?.draw() ?? null
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", className)}>
      <header className="sticky top-0 z-10 bg-background/80 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
        <div className="mx-auto flex min-h-11 max-w-2xl items-center gap-3">
          {leading}
          <h1 className="text-xl font-semibold tracking-tight">{named ?? title}</h1>
          {shown && <div className="ml-auto flex min-h-11 shrink-0 items-center">{shown}</div>}
        </div>
      </header>
      <HeaderSlot.Provider value={publish}>
        <TitleSlot.Provider value={setNamed}>
          <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
            {children}
          </div>
        </TitleSlot.Provider>
      </HeaderSlot.Provider>
    </div>
  )
}

/**
 * Names the screen this page draws under, under nothing: the title is the page's fact while it is
 * mounted, and the route's own returns when it unmounts or says nothing. Hand it an undefined title
 * while the answer it is named by is still out, and the route's title stands.
 */
export function useHeaderTitle(title: string | undefined) {
  const publish = useContext(TitleSlot)
  useEffect(() => {
    publish(title)
    return () => publish(undefined)
  }, [publish, title])
}

/**
 * Puts a control in the header of the Screen this page renders under, under `key`: the page owns
 * the slot until it unmounts, and a page that returns nothing takes its control with it. What the
 * header draws is read from a ref whenever the Screen renders, so hand over a node whose handlers
 * are stable (a state setter) — the header does not re-render when the page does.
 */
export function useHeaderAction(key: string, action: ReactNode) {
  const publish = useContext(HeaderSlot)
  const node = useRef(action)
  useEffect(() => {
    node.current = action
  })
  useEffect(() => {
    publish(key, () => node.current)
    return () => publish(key, null)
  }, [publish, key])
}

/** The rounded card list with hairline separators the Settings rows sit in. */
export function Group({ children }: { children: ReactNode }) {
  return (
    <div
      data-settings-group
      className="flex flex-col gap-px overflow-hidden rounded-3xl bg-border ring-1 ring-foreground/10 *:rounded-none"
    >
      {children}
    </div>
  )
}

export const rowClass =
  "flex min-h-14 w-full items-center gap-4 bg-card px-5 py-3 text-left text-card-foreground"
/** `rowClass` for a row that opens something. */
export const linkRowClass = `${rowClass} transition-colors hover:bg-muted`
/** The row that heads the group it controls: the card's own fill, taller than the rows beneath it. */
export const headerRowClass = `${rowClass} bg-muted py-4`

/** A row's title over its muted second line. */
export function RowText({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-base">{title}</span>
      {subtitle && <span className="line-clamp-2 text-sm text-muted-foreground">{subtitle}</span>}
    </span>
  )
}

/** A row that goes somewhere: one composition for the Settings menu and every screen that lists bots. */
export function LinkRow({
  to,
  current,
  replace,
  leading,
  title,
  subtitle,
  ...rest
}: {
  to: string
  current?: boolean
  replace?: boolean
  leading?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
} & Omit<ComponentProps<typeof Link>, "to" | "children" | "title" | "subtitle">) {
  return (
    <Link
      to={to}
      replace={replace}
      aria-current={current ? "page" : undefined}
      className={cn(linkRowClass, "aria-[current=page]:bg-muted")}
      {...rest}
    >
      {leading}
      <RowText title={title} subtitle={subtitle} />
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  )
}

/** A row that opens a pop-up of its own: the row chrome, and the open state the sheet takes. */
export function SheetRow({
  icon: Icon,
  title,
  sheet,
}: {
  icon: LucideIcon
  title: string
  sheet: (sheetProps: { open: boolean; onOpenChange: (open: boolean) => void }) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={linkRowClass}>
        <Icon className="size-5 shrink-0 text-muted-foreground" />
        <RowText title={title} />
      </button>
      {sheet({ open, onOpenChange: setOpen })}
    </>
  )
}

/** A row that runs something: the row chrome, its icon, its title, and a chevron like a link's. */
export function ActionRow({
  icon: Icon,
  title,
  onClick,
}: {
  icon: LucideIcon
  title: string
  onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick} className={linkRowClass}>
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <RowText title={title} />
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

/** The row every Settings switch wears: an optional icon, a title over a muted line, and the switch. */
export function SwitchRow({
  id,
  icon: Icon,
  title,
  experimental,
  subtitle,
  extra,
  checked,
  disabled,
  variant,
  onCheckedChange,
  ...rest
}: {
  id: string
  /** A category header is a title alone, so a row without one draws nothing in the icon's place. */
  icon?: LucideIcon
  title: string
  experimental?: boolean
  subtitle?: string
  /** Extra lines under the subtitle, inside the row's own column (a skill's health line). */
  extra?: ReactNode
  checked: boolean
  disabled?: boolean
  /** `header` tops a group of switches it controls; `nested` is one of them. */
  variant?: "header" | "nested"
  onCheckedChange: (checked: boolean) => void
} & Record<`data-${string}`, string | undefined>) {
  return (
    <label
      htmlFor={id}
      className={cn(
        variant === "header" ? headerRowClass : rowClass,
        "cursor-pointer",
        variant === "nested" && "pl-9",
        // A shut row dims as a whole: the switch greys itself, and a title left at full strength
        // would read as a setting a reader can still change.
        disabled && "opacity-60",
      )}
      {...rest}
    >
      {Icon && <Icon className="size-5 shrink-0 text-muted-foreground" />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("truncate text-base", variant === "header" && "font-semibold")}>
            {title}
          </span>
          {experimental && <ExperimentalBadge />}
        </span>
        {subtitle && <span className="line-clamp-2 text-sm text-muted-foreground">{subtitle}</span>}
        {extra}
      </span>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </label>
  )
}

/** The muted caption over a card: how a page names its groups now, in place of a heading. */
export function Caption({ children }: { children: ReactNode }) {
  return <p className="px-5 text-[13px] font-medium text-muted-foreground">{children}</p>
}

/**
 * A pick's surface: the sheet a phone and a tablet get, or the centred card a wide screen gets, the
 * same list inside either. It is not a screen of its own, so nothing is pushed and nothing is kept.
 */
export function PickSurface({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: ReactNode
}) {
  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent initialFocus={false}>
        <PopupHeader>
          <PopupTitle>{title}</PopupTitle>
        </PopupHeader>
        <div className="flex min-h-0 flex-col overflow-y-auto px-4 pb-4">{children}</div>
      </PopupContent>
    </Popup>
  )
}

/** The centred card a wide screen shows an edit in; below 1024px the edit is a pushed screen. */
export function EditCard({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

/**
 * A back that leaves an *edit screen* holding changes asks first: the dialog is the screen's to draw,
 * and the handler it hands out is the one a back button calls. An edit drawn as a card registers no
 * changes at all, so a back over one leaves without a word — a pop-up is closed, not committed.
 */
export function useLeaveGuard(leave: () => void) {
  const [asking, setAsking] = useState(false)
  // The handler is stable, so a screen can publish the same one to the system's own back without
  // publishing it again on every render.
  const latest = useRef(leave)
  latest.current = leave
  const go = useCallback(() => latest.current(), [])
  const back = useCallback(() => {
    if (holdsUnsavedChanges()) setAsking(true)
    else go()
  }, [go])
  return {
    back,
    dialog: (
      <ConfirmDestructive
        open={asking}
        title="Discard changes?"
        description="What you typed in this edit isn't saved. Going back leaves it as it was."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onOpenChange={setAsking}
        onConfirm={() => {
          setAsking(false)
          go()
        }}
      />
    ),
  }
}

/** A form field's label: the muted line above the input, the same everywhere one is typed into. */
export const fieldLabelClass = "px-1 text-sm text-muted-foreground"
/** A form field's input: a filled pill a thumb can find, at the height every edit screen uses. */
export const fieldInputClass = "h-12 rounded-full bg-muted px-4 text-base"
/** The same field inside a group that already draws the pill: only the room and the type are left. */
export const fieldInnerClass = "h-12 px-4 text-base"
/** A field holding several lines: the same filled room, with the room a sentence needs. */
export const fieldAreaClass = "bg-muted px-4 text-base"

export const NOT_SET = "Not set"

/**
 * A setting's row: its title, the line saying what it is for where that earns its place, and the
 * value it holds in the accent colour — mute `purpose` and the row is title over value. No chevron:
 * the value and the press state are what mark a row tappable (ADR 0055).
 */
export function ValueRow({
  title,
  tag,
  purpose,
  value,
  muted,
  onClick,
  disabled,
  busy,
  trailing,
  children,
  ...rest
}: {
  title: string
  /** A short mark beside the title, in the accent colour: which side of the app owns the row. */
  tag?: string
  /** What the setting is for: kept only where the row drills in or the purpose isn't obvious. */
  purpose?: string
  /** The value the setting holds; left off where the row holds something other than a value. */
  value?: string | null
  /** The value is not this row's to claim as written here — the host's own default, a copy this
   * device cached, or a setting that is unavailable — so it reads muted rather than accented. */
  muted?: boolean
  onClick?: () => void
  disabled?: boolean
  /** While a pick is on its way to the host: the row wears `aria-busy` and takes no taps. */
  busy?: boolean
  /** A control of the row's own, after its value: a bot's avatar, or the button that runs it. */
  trailing?: ReactNode
  /** A line of the row's own under its value: the answer a row reports rather than holds. */
  children?: ReactNode
} & Record<`data-${string}`, string | undefined>) {
  const holds = Boolean(value && String(value).trim())
  const body = (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-base">{title}</span>
        {tag && (
          <span
            data-tag={tag}
            className="shrink-0 rounded-full bg-primary/10 px-1.5 text-xs leading-5 text-primary"
          >
            {tag}
          </span>
        )}
      </span>
      {purpose && <span className="line-clamp-2 text-sm text-muted-foreground">{purpose}</span>}
      {value != null && (
        <span
          className={cn(
            "truncate text-sm",
            holds && !muted ? "text-primary" : "text-muted-foreground",
          )}
        >
          {holds ? value : NOT_SET}
        </span>
      )}
      {children}
    </span>
  )
  const state = { "aria-busy": busy || undefined, ...rest }
  // A row with a control of its own can't be one button: the tap column and the control sit side by
  // side, as a split switch row's do, so the control's own tap never reaches the row behind it.
  if (onClick && trailing)
    return (
      <div className={cn(rowClass, "gap-0 p-0", disabled && "opacity-60")}>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          className="flex min-h-14 min-w-0 flex-1 items-center gap-4 px-5 py-3 text-left transition-colors hover:bg-muted disabled:cursor-default"
          {...state}
        >
          {body}
        </button>
        <span className="flex shrink-0 items-center pr-5">{trailing}</span>
      </div>
    )
  if (!onClick)
    return (
      <div
        className={cn(
          rowClass,
          trailing ? "items-center" : "items-start",
          disabled && "opacity-60",
        )}
        aria-disabled={disabled || undefined}
        {...state}
      >
        {body}
        {trailing}
      </div>
    )
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(linkRowClass, "items-start disabled:opacity-60")}
      {...state}
    >
      {body}
    </button>
  )
}

/**
 * The column an edit fills when it is the screen the route pushed: it takes the screen's height, so
 * its last row — the actions — stands on the screen's floor rather than halfway up it.
 */
export const formColumnClass = "flex min-h-[calc(100dvh-7rem)] flex-1 flex-col gap-6"

/**
 * A screen-form's foot: the actions pinned to the bottom of the screen, so a form taller than a phone
 * keeps its Save within a thumb's reach while the fields scroll under it. It takes the safe area as
 * its own (`DESIGN.md`: the foot of the screen belongs to the phone), and cancels the screen column's
 * own bottom padding so the bar sits on the floor rather than above it. Only ever a screen's — a card
 * is closed, not committed, and its actions stand under its last field.
 */
export function FormFoot({ children }: { children: ReactNode }) {
  return (
    <div
      data-form-foot
      className="sticky bottom-0 z-10 -mb-[max(2rem,env(safe-area-inset-bottom))] mt-auto flex flex-col bg-gradient-to-t from-background from-40% via-background/95 to-transparent px-1 pt-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      {children}
    </div>
  )
}

/**
 * The bar an edit form's actions sit in: one pill, the cancel and the save divided by a hairline,
 * centred under the fields. Every edit wears it — pushed as a screen on a phone, drawn as a card
 * above 1024px — so the two ways of editing are one form, and a reset, where the form has one,
 * leads the bar. Save is the form's submit, so a caller keeps its own `onSubmit`.
 */
export function FormActions({
  onCancel,
  onReset,
  resetLabel = "Reset",
  saveLabel = "Save",
  disabled,
  busy,
  className,
  destructive,
}: {
  /** The form's way out. Left off by a form whose Reset leads instead: back is its cancel. */
  onCancel?: () => void
  /**
   * The form's nothing value: for a host setting, the key leaving the file. A form that has one leads
   * with it in place of Cancel — back is what cancels, and the bar asks only what the screen can do.
   */
  onReset?: () => void
  resetLabel?: string
  saveLabel?: string
  /** The leading action deletes something, so it wears the destructive ink rather than a row's. */
  destructive?: boolean
  /** Cancels and saves both wait while the form holds nothing worth writing. */
  disabled?: boolean
  busy?: boolean
  className?: string
}) {
  return (
    <div
      data-form-actions
      className={cn(
        "mx-auto flex w-fit max-w-full items-center rounded-full bg-muted p-1",
        className,
      )}
    >
      {onReset ? (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={onReset}
            className={cn(actionClass, destructive && "text-destructive")}
          >
            {resetLabel}
          </button>
          <Divider />
        </>
      ) : onCancel ? (
        <>
          <button type="button" onClick={onCancel} className={actionClass}>
            Cancel
          </button>
          <Divider />
        </>
      ) : null}
      <button type="submit" disabled={disabled || busy} className={cn(actionClass, "font-medium")}>
        {busy && <Spinner />}
        {saveLabel}
      </button>
    </div>
  )
}

const actionClass =
  "flex min-h-11 items-center justify-center gap-2 rounded-full px-5 text-base text-foreground transition-colors hover:bg-background/40 disabled:opacity-50"

/** The hairline between two of the bar's actions: drawn, never read out. */
function Divider() {
  return <span aria-hidden className="h-6 w-px shrink-0 bg-border" />
}

/**
 * The form a text value is edited in, whether it is pushed as a screen or shown as a centred card:
 * a labelled field holding the value, and the actions bar beneath it. Nothing is written until Save,
 * and Cancel writes nothing at all — the one write is what the row then shows. On a phone the form
 * fills the screen so the bar stands at its foot; in a card it stops under its field.
 */
export function EditForm({
  label,
  value,
  placeholder,
  kind = "text",
  note,
  busy,
  surface,
  saveable,
  resetLabel,
  resetDestructive,
  onSave,
  onReset,
  onCancel,
}: {
  label: string
  value: string
  placeholder?: string
  /** `url` asks for a keyboard's URL key; `secret` masks the value behind a show toggle. */
  kind?: "text" | "url" | "secret" | "number"
  /** A line under the field about the write itself: when the host reads the key, say. */
  note?: string
  onSave: (value: string) => void
  /** The form's nothing value, where the host holds one: the key leaving the file. */
  onReset?: () => void
  /** What the reset is called where its own word says what goes: *Delete key*. */
  resetLabel?: string
  /** The reset deletes something rather than clearing a value: it wears the destructive ink. */
  resetDestructive?: boolean
  onCancel?: () => void
  /** A write already on its way: the bar waits, and says so. */
  busy?: boolean
  /**
   * Where this form is drawn: the screen the route pushed, or a card over a page. It is the caller's
   * fact — the container chose it — and it decides both how the form fills and whether a back asks.
   */
  surface?: "screen" | "card"
  /**
   * Whether Save is offered for what the field holds. The default is the whole of an ordinary edit —
   * a value that differs from the one it started at — and a form whose field may hold something
   * that must not be written passes its own rule, as the key form does with a mask.
   */
  saveable?: (next: string) => boolean
}) {
  const [draft, setDraft] = useState(value)
  const [shown, setShown] = useState(false)
  const id = `edit-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
  const next = kind === "text" ? draft.trim() : draft
  const offers = saveable ?? ((held: string) => held !== value)
  // What a back would throw away — only where the form is the screen. A card is a pop-up, and closing
  // a pop-up is the whole of saying no: nothing is asked.
  useUnsavedChanges(surface === "screen" && next !== value)
  const actions = (
    <FormActions
      className={surface === "screen" ? undefined : "mt-auto"}
      onCancel={onCancel}
      onReset={onReset}
      resetLabel={resetLabel}
      destructive={resetDestructive}
      disabled={!offers(next)}
      busy={busy}
    />
  )
  return (
    <form
      className={cn(surface === "screen" ? formColumnClass : "flex flex-col gap-6")}
      onSubmit={(event) => {
        event.preventDefault()
        onSave(next)
      }}
    >
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
            inputMode={kind === "url" ? "url" : kind === "number" ? "decimal" : undefined}
            type={kind === "secret" && !shown ? "password" : "text"}
            placeholder={placeholder}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          {kind === "secret" && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-sm"
                className="mr-1 size-10 rounded-full"
                aria-label={shown ? "Hide key" : "Show key"}
                onClick={() => setShown((open) => !open)}
              >
                {shown ? <EyeOffIcon /> : <EyeIcon />}
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        {note && <p className="mt-3 px-1 text-center text-sm text-muted-foreground">{note}</p>}
      </div>
      {surface === "screen" ? <FormFoot>{actions}</FormFoot> : actions}
    </form>
  )
}

/**
 * One model pick, wherever a setting offers one: its surface, the sentence a host that answered no
 * models leaves, and the close every pick makes. `onPick`'s refusal is said once, over the page.
 */
export function ModelPick({
  open,
  title,
  profile,
  choice,
  fallback,
  onPick,
  onClose,
}: {
  open: boolean
  title: string
  profile: Profile
  /** The model the pick marks as in force. */
  choice?: ModelChoice
  /** The row that clears the choice: its label and the model it runs. */
  fallback: { label: string; model?: string }
  onPick: (choice: ModelChoice | undefined) => void | Promise<void>
  onClose: () => void
}) {
  const info = useModelInfo(profile)
  const providers = info?.providers ?? []
  return (
    <PickSurface open={open} onOpenChange={(next) => !next && onClose()} title={title}>
      {providers.length ? (
        <ModelPicker
          header={false}
          providers={providers}
          fallback={fallback}
          recent={profile.recentModels}
          choice={choice}
          onChoose={(next) => {
            void Promise.resolve(onPick(next)).catch((error: unknown) => {
              toast.error(error instanceof Error ? error.message : String(error))
            })
            onClose()
          }}
        />
      ) : (
        <p className="px-1 py-2 text-sm text-muted-foreground">Couldn't read this bot's models.</p>
      )}
    </PickSurface>
  )
}

/** One thing a list can pick: what it is called, and the muted line saying what it is. */
export type PickOption = {
  id: string
  label: string
  detail?: string
  /** A muted word beside the label, for one row of a list that stands out from its neighbours. */
  badge?: string
  /** What the row shows before its label, a bot's avatar for one. */
  leading?: ReactNode
}

/**
 * The list a pick offers: searchable where there is much to search, a row per option with the chosen
 * one ticked. It is the same list whether it is pushed as a screen or shown in a card.
 */
export function PickList({
  label,
  options,
  selected,
  onPick,
  searchable,
}: {
  label: string
  options: PickOption[]
  selected?: string
  onPick: (id: string) => void
  /** Whether a search field sits on top; default is on once there are more than six. */
  searchable?: boolean
}) {
  const [query, setQuery] = useState("")
  const search = searchable ?? options.length > 6
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = options.filter((option) =>
    words.every((word) => `${option.label} ${option.detail ?? ""}`.toLowerCase().includes(word)),
  )
  return (
    <div className="flex min-h-0 flex-col gap-3">
      {search && (
        <SearchField
            value={query}
            onChange={setQuery}
            label={`Search ${label.toLowerCase()}`}
          />
      )}
      <div data-pick-list={label} className="flex min-h-0 flex-col overflow-y-auto">
        <PickGroup mode="choose" label={label}>
          {shown.map((option) => (
            <PickRow
              key={option.id}
              leading={option.leading}
              selected={option.id === selected}
              title={
                <>
                  <span className="text-base break-all">{option.label}</span>
                  {option.badge && (
                    // Muted, and outlined rather than filled: a chosen row is already `bg-muted`.
                    <span
                      className="shrink-0 rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
                      data-pick-badge
                    >
                      {option.badge}
                    </span>
                  )}
                </>
              }
              line={option.detail}
              onPick={() => onPick(option.id)}
            />
          ))}
        </PickGroup>
        {!shown.length && <p className="px-1 text-sm text-muted-foreground">Nothing matches.</p>}
      </div>
    </div>
  )
}

/** A row that both opens something and toggles: two fully clickable columns, the left doing the tap
 * and the right the switch, so turning a setting on never opens the screen behind it.
 */
export function SplitSwitchRow({
  icon: Icon,
  title,
  subtitle,
  extra,
  switchLabel,
  checked,
  disabled,
  onOpen,
  onCheckedChange,
}: {
  icon?: LucideIcon
  title: string
  subtitle?: ReactNode
  /** Extra lines under the subtitle, still inside the clickable left column (a skill's health line). */
  extra?: ReactNode
  /** The switch's own accessible name; defaults to `title`. */
  switchLabel?: string
  checked: boolean
  disabled?: boolean
  onOpen: () => void
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className={cn(rowClass, "gap-0 p-0")}>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-14 min-w-0 flex-1 items-center gap-4 px-5 py-3 text-left transition-colors hover:bg-muted"
      >
        {Icon && <Icon className="size-5 shrink-0 text-muted-foreground" />}
        <span className="flex min-w-0 flex-1 flex-col">
          <RowText title={title} subtitle={subtitle} />
          {extra}
        </span>
      </button>
      {/* The label holds only the switch, so a tap here toggles and never reaches the column beside
          it. Its words are hidden: the switch's element is a span, which takes its name from the
          label it sits in, and without them the name is empty. */}
      <label className="flex min-h-14 shrink-0 cursor-pointer items-center px-5 py-3">
        <span className="sr-only">{switchLabel ?? title}</span>
        <Switch
          aria-label={switchLabel ?? title}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
        />
      </label>
    </div>
  )
}
