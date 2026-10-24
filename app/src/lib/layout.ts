/**
 * The reading column a chat's non-card parts carry: the 768px box's own 736px of text, centred
 * in the pane whose 16px gutters sit outside it, so text lands on the same pixels at every width.
 * A card the app draws inside a chat takes COLUMN_BOX instead — it fills its container up to that
 * box and never past it (ADR 0047, superseding ADR 0041).
 */
export const COLUMN = "mx-auto w-full max-w-[736px]"

/**
 * The box COLUMN is the interior of, and the width no in-chat card passes: the two differ by the
 * 16px gutters either side of the text, so a card capped here frames the text measure exactly.
 */
export const COLUMN_BOX = "mx-auto w-full max-w-3xl"
