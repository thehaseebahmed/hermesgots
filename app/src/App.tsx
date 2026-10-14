import { lazy, useEffect } from "react"
import { useTheme } from "next-themes"
import { useLiveQuery } from "dexie-react-hooks"
import { Navigate, Route, Routes } from "react-router"

import { AppShell } from "@/components/app-shell"
import { getActiveProfile } from "@/lib/db"
import { useLaunchRestore, useRecordLastChat } from "@/lib/launch"
import { warmCatalog } from "@/lib/models"
import { warmRankings } from "@/lib/rankings"
import { useShareReceiver } from "@/lib/share"
import { useBotThreads } from "@/lib/threads"
import { ChatPage } from "@/routes/chat"
import { SetupGate } from "@/routes/setup"

// Only a chat is on the startup path; every other screen loads when it's first opened.
const BotThreadsPage = lazy(() =>
  import("@/routes/bot-threads").then((m) => ({ default: m.BotThreadsPage })),
)
const BotsPage = lazy(() => import("@/routes/bots").then((m) => ({ default: m.BotsPage })))
const OpenSessionPage = lazy(() =>
  import("@/routes/open-session").then((m) => ({ default: m.OpenSessionPage })),
)
const CodePage = lazy(() => import("@/routes/code").then((m) => ({ default: m.CodePage })))
const ProjectPage = lazy(() => import("@/routes/project").then((m) => ({ default: m.ProjectPage })))
const ResearchPage = lazy(() =>
  import("@/routes/research").then((m) => ({ default: m.ResearchPage })),
)
const MissionPage = lazy(() =>
  import("@/routes/research").then((m) => ({ default: m.MissionPage })),
)
const RoutinesPage = lazy(() =>
  import("@/routes/routines").then((m) => ({ default: m.RoutinesPage })),
)
const SharePage = lazy(() => import("@/routes/share").then((m) => ({ default: m.SharePage })))
const SettingsPage = lazy(() =>
  import("@/routes/settings").then((m) => ({ default: m.SettingsPage })),
)

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
  // The model sheet reads the catalog and rankings on every open, so warm them here: a
  // returning user's facts and scores refresh in the background without the sheet fetching.
  useEffect(() => {
    void warmCatalog()
    void warmRankings()
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
        <Route path="settings/:section?/:botId?" element={<SettingsPage />} />
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
