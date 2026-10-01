import { useEffect } from "react"
import { useTheme } from "next-themes"
import { Route, Routes } from "react-router"

import { AppShell } from "@/components/app-shell"
import { ChatPage } from "@/routes/chat"
import { SettingsPage } from "@/routes/settings"

/** Keeps the browser/OS chrome colour in step with the active theme. */
function ThemeColor() {
  const { resolvedTheme } = useTheme()
  useEffect(() => {
    const color = getComputedStyle(document.body).backgroundColor
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
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<ChatPage />} />
        </Route>
      </Routes>
    </>
  )
}
