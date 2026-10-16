import { createContext, useContext } from "react"

import { useLarge } from "@/lib/media"

/** What a pop-up is on this screen: see `Popup` in `components/popup.tsx`. */
export type PopupForm = "sheet" | "drawer" | "menu"

export const PopupFormContext = createContext<PopupForm>("sheet")

/** Whether a pop-up opened now is a side drawer (or an anchored menu) rather than a bottom sheet. */
export function usePopupDrawer() {
  return useLarge()
}

/** The form of the pop-up this is rendered in. */
export function usePopupForm() {
  return useContext(PopupFormContext)
}
