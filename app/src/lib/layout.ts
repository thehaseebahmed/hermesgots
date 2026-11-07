/**
 * The reading column a chat's non-card parts carry: the 672px box's own 640px of text, centred in
 * the pane, so text lands on the same pixels at every width and a chat reads at the measure the
 * app's list screens read at (`max-w-2xl`, 672px with their own 16px gutters inside it).
 * A card the app draws inside a chat takes COLUMN_BOX instead — it fills its container up to that
 * box and never past it (ADR 0047, superseding ADR 0041; the measure itself ADR 0114).
 */
export const COLUMN = "mx-auto w-full max-w-[640px]"

/**
 * The box COLUMN is the interior of, and the width no in-chat card passes: the two differ by the
 * 16px gutters either side of the text, so a card capped here frames the text measure exactly.
 */
export const COLUMN_BOX = "mx-auto w-full max-w-[672px]"

/**
 * The inset every part of a reply stands on — its text, the interface a block draws, the rows that
 * account for its work — so one edge serves them all and a block starting to draw moves nothing
 * (ADR 0058). A card fills COLUMN_BOX to its own gutters instead (ADR 0047).
 */
export const REPLY_INSET = "px-1"

/** The reply's edge as a whole, so every part of a reply and the thread draw one column. */
export const REPLY_EDGE = `${REPLY_INSET} ${COLUMN}`

/** The size a reply's words are drawn at — the measure a screen copying the look must share. */
export const REPLY_TEXT = "text-[15px] leading-relaxed"
