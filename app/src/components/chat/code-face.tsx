import { createContext, useContext } from "react"

/**
 * The face everything said in a chat is drawn in — the user's messages, the agent's replies, the
 * rows for its thinking and its calls, the composer's text, and what a thought or a call opens
 * into: `font-code`, JetBrains Mono, in every chat and session. The chrome around it (headers,
 * pills, buttons, a sheet's heading) never asks and stays in the app's own. A context and not a
 * class on the pane, because the sheets a tool call or a thought opens are portaled out of it:
 * context crosses a portal, so their input and output read in the face while their headings stay
 * in the app's own. Outside a chat there is no provider, so the same components read as before.
 */
const CodeFaceContext = createContext<"font-code" | undefined>(undefined)

export const CodeFaceProvider = CodeFaceContext.Provider

/** What a chat's root provides. */
export const CHAT_FACE = "font-code" as const

/** The class for agent output that reads in the app's face by default. */
export const useCodeFace = () => useContext(CodeFaceContext)

/** The class for text that is monospace anyway: the chat's face inside a chat, else the default. */
export const useMonoFace = () => useContext(CodeFaceContext) ?? "font-mono"
