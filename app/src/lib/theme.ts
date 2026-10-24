import { useTheme } from "next-themes"

/**
 * The three colour modes Settings offers, in the order Appearance draws them, and the label the
 * Settings menu shows for the one in use. One list, so the switch and the row that names it can
 * never disagree.
 */
export const THEMES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const

export type ThemeValue = (typeof THEMES)[number]["value"]

/** The label of a stored theme, with anything unset read as following the system. */
export function themeLabel(value: string | undefined) {
  return THEMES.find((theme) => theme.value === (value ?? "system"))?.label ?? THEMES[0].label
}

/**
 * Whether the app is drawing dark, as next-themes resolved the stored choice: `system` follows the
 * OS, and a page that isn't mounted yet reads as light.
 */
export function useDark() {
  return useTheme().resolvedTheme === "dark"
}
