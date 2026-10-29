import { createContext, useContext } from "react"

/**
 * The face the thread draws the agent's own output in: `font-code` in a code session, nothing
 * otherwise. A context and not a class on the pane, because the sheets a tool call or a thought
 * opens are portaled out of it: context crosses a portal, so their input and output read in the
 * face while their headings, which never ask, stay in the app's own.
 */
const CodeFaceContext = createContext<"font-code" | undefined>(undefined)

export const CodeFaceProvider = CodeFaceContext.Provider

/** The class for agent output that reads in the app's face by default. */
export const useCodeFace = () => useContext(CodeFaceContext)

/** The class for text that is monospace anyway: the code face in a code session, else the default. */
export const useMonoFace = () => useContext(CodeFaceContext) ?? "font-mono"
