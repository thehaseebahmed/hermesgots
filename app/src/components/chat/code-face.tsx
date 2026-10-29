import { createContext, useContext } from "react"

/**
 * Whether the thread draws the agent's own output in the code face (a code session). A context and
 * not a class on the pane, because the sheets a tool call or a thought opens are portaled out of
 * it: context crosses a portal, so their input and output read in the face while their headings,
 * which never ask, stay in the app's own.
 */
const CodeFaceContext = createContext(false)

export const CodeFaceProvider = CodeFaceContext.Provider

/** Whether the agent's output reads in the code face here. */
export const useCodeFace = () => useContext(CodeFaceContext)

/** The face for text that is monospace anyway: the code face in a code session, else the default. */
export const useMonoFace = () => (useContext(CodeFaceContext) ? "font-code" : "font-mono")
