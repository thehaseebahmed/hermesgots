import { useEffect } from "react"
import { useTheme } from "next-themes"
import { Route, Routes } from "react-router"

import { AppShell } from "@/components/app-shell"
import { BotsPage } from "@/routes/bots"
import { ChatPage } from "@/routes/chat"
import { RoutinesPage } from "@/routes/routines"
import { SettingsPage } from "@/routes/settings"

/** Computed colours come back as oklch(), which browser chrome may not parse; hex always works. */
function toHex(color: string) {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!context) return color
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`
}

/** Keeps the browser/OS chrome colour in step with the active theme. */
function ThemeColor() {
  const { resolvedTheme } = useTheme()
  useEffect(() => {
    const color = toHex(getComputedStyle(document.body).backgroundColor)
    document
      .querySelectorAll('meta[name="theme-color"]')
      .forEach((meta) => meta.setAttribute("content", color))
  }, [resolvedTheme])
  return null
}

export default function App() {
  return (
    <>
      <ThemeColor />
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<ChatPage />} />
          <Route path="c/:id" element={<ChatPage />} />
          <Route path="routines" element={<RoutinesPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="bots" element={<BotsPage />} />
          <Route path="*" element={<ChatPage />} />
        </Route>
      </Routes>
    </>
  )
}
