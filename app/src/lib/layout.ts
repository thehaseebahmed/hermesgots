/**
 * The one column a chat and a list screen draw in: a 672px box centred in the pane, its gutters
 * outside it, so the header, a reply's text, a card and a list's rows all start on the header's
 * leading edge at every width (ADR 0166, amending ADR 0114). A card fills it, and never passes it
 * (ADR 0047).
 */
export const COLUMN = "mx-auto w-full max-w-[672px]"

/**
 * A thread's gutters inside a chat's scroller: 16px on the left, and 16px less the scrollbar's own
 * width on the right (the scroller root's width, `100cqw`, less the content box's, `100%`), so the
 * thread's box is the header's box at every width and the column centres on the pane as the header
 * does (ADR 0166). An overlay scrollbar takes no width and leaves both gutters 16px.
 */
export const THREAD_GUTTER = "pl-4 pr-[max(0px,calc(1rem_-_(100cqw_-_100%)))]"

/**
 * A list screen's body: the column with its 16px gutters outside the box, so its rows start on the
 * same pixel as its header (`px-4` around a `COLUMN` row) instead of 16px inside it (ADR 0166).
 */
export const PAGE_BODY = "mx-auto w-full max-w-[704px] px-4"

/**
 * The round outline button a header bar wears — a Project's menu, a chat's options, a canvas's Undo,
 * Edit and Preview — so every top bar reads as the same bar. A caller adds what its own place asks of
 * it (`shrink-0`, `pointer-events-auto`, `md:hidden`, a back control's own surface).
 */
export const HEADER_BUTTON = "size-11 rounded-full bg-background/80 backdrop-blur"

/** The foot every chat screen gives its composer, so the app and a blank surface share one gutter. */
export const COMPOSER_SLOT = "px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4"

/**
 * The inset every part of a reply stands on — its text, the interface a block draws, the rows that
 * account for its work — so one edge serves them all and a block starting to draw moves nothing
 * (ADR 0058). A card fills COLUMN instead (ADR 0047).
 */
export const REPLY_INSET = "px-1"

/** The reply's edge as a whole, so every part of a reply and the thread draw one column. */
export const REPLY_EDGE = `${REPLY_INSET} ${COLUMN}`

/** The size a reply's words are drawn at — the measure a screen copying the look must share. */
export const REPLY_TEXT = "text-[15px] leading-relaxed"
