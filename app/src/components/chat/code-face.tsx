import { createContext, useContext } from "react"

/**
 * The face a coding session is said in: `font-code`, JetBrains Mono — the user's bubbles, the
 * replies, the rows for its thinking and its calls, the composer's text, and what a thought opens
 * into. A plain chat with a bot keeps the app's own face, and so does all the chrome (headers,
 * pills, buttons, a sheet's heading), which never asks. A context and not a class on the pane,
 * because the sheets a tool call or a thought opens are portaled out of it: context crosses a
 * portal, so their words read in the face while their headings stay in the app's own. A tool call's
 * own input and output are the exception that needs no context: they are always `font-code`
 * (`tool-card.tsx`), in a chat as in a session.
 */
const CodeFaceContext = createContext<"font-code" | undefined>(undefined)

export const CodeFaceProvider = CodeFaceContext.Provider

/** What a coding session's root provides. */
export const CHAT_FACE = "font-code" as const

/** The class for agent output that reads in the app's face by default. */
export const useCodeFace = () => useContext(CodeFaceContext)

/** The class for text that is monospace anyway: the session's face inside a coding session, else the default. */
export const useMonoFace = () => useContext(CodeFaceContext) ?? "font-mono"
