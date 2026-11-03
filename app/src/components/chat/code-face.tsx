import { createContext, useContext } from "react"

/**
 * The **Code face** a project session is said in: `font-code`, JetBrains Mono. It reaches what the
 * bot said and what the user said in that session — the user's bubbles, the replies, the rows for
 * its thinking and its calls, the status line, the composer's text, what a thought opens into, and
 * the bot's own words inside a card (a question and its choices, an approval's description, a
 * subagent's goal) (ADR 0087).
 *
 * It stops at the chrome, which keeps the app's face everywhere: a card's title, a button, a count,
 * a pill, a sheet's heading, the stats line, a divider. A plain chat with a bot has no code face at
 * all, and a tool call's own input and output are always `font-code` (`tool-card.tsx`), in a chat as
 * in a session: they need no context to say so.
 *
 * A context and not a class on the pane, because the sheets a tool call or a thought opens are
 * portaled out of it: context crosses a portal, so their words read in the face while their headings
 * stay in the app's own.
 */
const CodeFaceContext = createContext<"font-code" | undefined>(undefined)

export const CodeFaceProvider = CodeFaceContext.Provider

/** What a project session's root provides. */
export const CODE_FACE = "font-code" as const

/** The class for the bot's own words: the session's face inside a session, else the app's own. */
export const useCodeFace = () => useContext(CodeFaceContext)

/** The class for text that is monospace anyway: the session's face inside a coding session, else the default. */
export const useMonoFace = () => useContext(CodeFaceContext) ?? "font-mono"
