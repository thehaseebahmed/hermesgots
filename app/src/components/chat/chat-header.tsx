import type { ReactNode } from "react"
import { BellOffIcon, MenuIcon } from "lucide-react"

import { useOpenDrawer } from "@/components/drawer-context"
import { Bot } from "@/components/bot"
import type { BotMood } from "@/components/bots"
import { Button } from "@/components/ui/button"
import { COLUMN_BOX, HEADER_BUTTON } from "@/lib/layout"
import { cn } from "@/lib/utils"

/**
 * The app sidebar's door: the drawer, where the sidebar is collapsed behind it. A screen that leads
 * with it passes it as `leading`; the header draws it itself where a caller has no leading control.
 */
export function SidebarButton({ className }: { className?: string }) {
  const openDrawer = useOpenDrawer()
  return (
    <Button
      variant="outline"
      size="icon-lg"
      className={cn(HEADER_BUTTON, "pointer-events-auto shrink-0", className)}
      onClick={openDrawer}
      aria-label="Open conversations"
    >
      <MenuIcon />
    </Button>
  )
}

/**
 * Floating header, read from the left: the drawer button (or `leading`), the bot's picture (unless
 * `showBot` is false), then the title with its status under it, both cut with an ellipsis; actions
 * right.
 * `centered` gives the arrangement of a place rather than a conversation with a bot — a coding
 * session, or a bot's thread open beside its Main: the same leading control, then the title centred
 * over its subtitle. The muted mark moves into the actions, so it cannot pull the title off centre.
 * A session is a place in a project and a thread open beside Main is already somewhere, so both pass
 * `showBot={false}`: the picture stays a caller's decision, and the arrangement doesn't second-guess
 * it.
 * `heading` draws the title as the screen's `<h1>` rather than a conversation's span, for a screen
 * whose whole page is one thing — a canvas — while every other caller keeps the span.
 * `pinned` is the same bar in its other form — see ADR 0140. A screen whose content is a list scrolls
 * its own rows, so its bar cannot float over them: it stands sticky and opaque in that flow, its title
 * is the screen's `<h1>` at the list's step, and `below` holds what the screen pins under the row (the
 * routines page's state chips). The row is the same row either way — the leading control, the title and
 * its line, the actions, every icon control a frosted outline circle.
 * `back` is the bar's own way back — the control that steps onto the list or the screen this one was
 * opened from — and it is drawn last in the actions row, in both forms: the corner is the bar's slot,
 * not an order each caller keeps, so no two conversations' bars can disagree about where their way
 * back stands.
 * `title` takes a node as well as a string, for a screen whose heading is also its way somewhere: the
 * chat list's name is the link to the bot's settings.
 * `onTitlePress` makes the whole block — the title and the line under it — one press, for a screen
 * whose title opens something: a thumb on the line, on the space between the lines or beside a short
 * title lands as one on the title does, while the control the caller draws inside stays the one a
 * reader and a keyboard press. The block is also what the thumb is given, so it is 44px tall whatever
 * its two lines come to, with the free space above and below them rather than between.
 * `className` can pin it in the page's flow instead.
 */
export function ChatHeader({
  title,
  subtitle,
  botId,
  botMood,
  muted,
  showBot = true,
  centered = false,
  heading = false,
  pinned = false,
  leading,
  actions,
  back,
  below,
  onTitlePress,
  className,
}: {
  title: ReactNode
  botId?: string
  /** How the bot feels, for a posed one: sleepy where the host is away. */
  botMood?: BotMood
  muted?: boolean
  showBot?: boolean
  centered?: boolean
  heading?: boolean
  pinned?: boolean
  subtitle?: ReactNode
  leading?: ReactNode
  actions?: ReactNode
  /** The bar's way back, drawn last in the actions row — the corner it is always drawn in. */
  back?: ReactNode
  /** What a pinned bar holds under its row, inside the same sticky box. */
  below?: ReactNode
  /** The press the whole title block answers, for a title that is a control. */
  onTitlePress?: () => void
  className?: string
}) {
  const mark = muted && (
    <BellOffIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Muted" />
  )
  const titleClass = cn(
    "min-w-0",
    pinned && heading
      ? "text-xl font-semibold tracking-tight"
      : pinned
        ? "truncate text-base font-semibold tracking-tight"
        : "truncate text-sm font-semibold",
    centered && "max-w-full",
  )

  return (
    <header
      className={cn(
        pinned
          ? "sticky top-0 z-10 bg-background/80 px-4 pt-[var(--list-header-pt)] pb-3 backdrop-blur"
          : "pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-background from-75% to-transparent px-4 pt-[var(--list-header-pt)] pb-6",
        className,
      )}
    >
      <div
        data-slot="header-row"
        className={cn(
          COLUMN_BOX,
          centered
            ? "grid grid-cols-[1fr_minmax(0,2fr)_1fr] items-center gap-3"
            : "flex items-center gap-3",
        )}
      >
        {leading ? (
          <div data-slot="header-leading" className="pointer-events-auto shrink-0">
            {leading}
          </div>
        ) : (
          <>
            <SidebarButton className="md:hidden" />
            {/* The centred arrangement holds the row's centre by both flanks sharing it, so where
                nothing leads the row — a coding session drawn beside Code's list — the leading
                track still takes a box. Below `md` the drawer above is that box. */}
            {centered && <div aria-hidden className="hidden size-11 md:block" />}
          </>
        )}
        {showBot && <Bot id={botId} animate mood={botMood} className="pointer-events-auto size-11" />}
        <div
          data-slot="header-middle"
          className={cn(
            "pointer-events-auto flex min-w-0 flex-1 items-center gap-1.5",
            centered && "justify-center",
          )}
        >
          <div
            className={cn(
              "flex min-w-0 flex-1 flex-col",
              centered && "items-center",
              // The block is the press, so it is the thumb's: 44px whatever its two lines come to,
              // with the free space above and below them rather than between, so the line sits as
              // tight under the title as in a head that draws no control at all. The ring lives here,
              // not on the caller's button, so the block can outline a focus the button owns: one
              // tab stop, one ring.
              onTitlePress &&
                "min-h-11 cursor-pointer justify-center rounded-lg hover:bg-muted/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-inset",
            )}
            onClick={onTitlePress}
          >
            {title &&
              (pinned || heading ? (
                <h1 data-slot="header-title" className={titleClass}>
                  {title}
                </h1>
              ) : (
                <span data-slot="header-title" className={titleClass}>
                  {title}
                </span>
              ))}
            {subtitle && (
              <span
                data-slot="header-line"
                className={cn(
                  "flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground",
                  centered && "max-w-full",
                )}
              >
                {typeof subtitle === "string" ? (
                  <span className="min-w-0 truncate">{subtitle}</span>
                ) : (
                  subtitle
                )}
              </span>
            )}
          </div>
          {!centered && mark}
        </div>
        <div
          data-slot="header-actions"
          className={cn(
            "pointer-events-auto flex shrink-0 items-center gap-2",
            centered && "justify-self-end",
          )}
        >
          {centered && mark}
          {actions}
          {back}
        </div>
      </div>
      {pinned && below && <div className="mx-auto max-w-2xl pt-3">{below}</div>}
    </header>
  )
}
