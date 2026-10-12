import { useEffect } from "react"
import { useTheme } from "next-themes"
import { useLiveQuery } from "dexie-react-hooks"
import { Navigate, Route, Routes } from "react-router"

import { AppShell } from "@/components/app-shell"
import { getActiveProfile } from "@/lib/db"
import { useLaunchRestore, useRecordLastChat } from "@/lib/launch"
import { warmCatalog } from "@/lib/models"
import { useShareReceiver } from "@/lib/share"
import { useBotThreads } from "@/lib/threads"
import { BotThreadsPage } from "@/routes/bot-threads"
import { BotsPage } from "@/routes/bots"
import { ChatPage } from "@/routes/chat"
import { OpenSessionPage } from "@/routes/open-session"
import { CodePage } from "@/routes/code"
import { ProjectPage } from "@/routes/project"
import { MissionPage, ResearchPage } from "@/routes/research"
import { RoutinesPage } from "@/routes/routines"
import { SharePage } from "@/routes/share"
import { SettingsPage } from "@/routes/settings"
import { SetupGate } from "@/routes/setup"

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

/** A new chat, or with bot threads on, the active bot, where a new thread starts. */
function Home() {
  const botThreads = useBotThreads()
  const active = useLiveQuery(
    async () => (botThreads ? ((await getActiveProfile()) ?? null) : null),
    [botThreads],
  )
  if (botThreads === undefined || (botThreads && active === undefined)) return null
  return active ? <Navigate to={`/b/${active.id}`} replace /> : <ChatPage />
}

function AppRoutes() {
  useRecordLastChat()
  useShareReceiver()
  // The model sheet reads the catalog on every open, so warm it here: a returning user's
  // facts refresh in the background without the sheet itself ever fetching.
  useEffect(() => {
    void warmCatalog()
  }, [])
  if (!useLaunchRestore()) return null
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        <Route path="b/:profileId" element={<BotThreadsPage />} />
        <Route path="c/:id" element={<ChatPage />} />
        <Route path="s/:sessionId" element={<OpenSessionPage />} />
        <Route path="code" element={<CodePage />} />
        <Route path="code/:profileId/:projectId" element={<ProjectPage />} />
        <Route path="routines" element={<RoutinesPage />} />
        <Route path="research" element={<ResearchPage />} />
        <Route path="research/:id" element={<MissionPage />} />
        <Route path="settings/:section?" element={<SettingsPage />} />
        <Route path="bots" element={<BotsPage />} />
        <Route path="share" element={<SharePage />} />
        <Route path="*" element={<ChatPage />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <>
      <ThemeColor />
      <SetupGate>
        <AppRoutes />
      </SetupGate>
    </>
  )
}
