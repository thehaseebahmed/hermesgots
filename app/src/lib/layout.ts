/**
 * The reading column a chat's non-card parts carry: the 768px box's own 736px of text, centred
 * in the pane whose 16px gutters sit outside it, so text lands on the same pixels at every width.
 * A card the app draws inside a chat fills the pane instead and carries none of this (ADR 0041).
 */
export const COLUMN = "mx-auto w-full max-w-[736px]"

/**
 * The box COLUMN is the interior of: the two differ by the 16px gutters either side of the text.
 * The composer, header, bot picker and banner draw in this box, so it moves with the column.
 */
export const COLUMN_BOX = "mx-auto w-full max-w-3xl"
