import { createContext, useContext } from "react"

export const DrawerContext = createContext<() => void>(() => {})

/** Opens the conversation drawer (phones only; tablets show the sidebar permanently). */
export function useOpenDrawer() {
  return useContext(DrawerContext)
}
