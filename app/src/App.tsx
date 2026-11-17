import { lazy, useEffect } from "react"
import { useTheme } from "next-themes"
import { useLiveQuery } from "dexie-react-hooks"
import { Navigate, Route, Routes, useParams } from "react-router"

import { AppShell } from "@/components/app-shell"
import { botMainPath } from "@/lib/bot-tabs"
import { useBotMain } from "@/lib/chat-rows"
import { getActiveProfile } from "@/lib/db"
import { warmCatalog } from "@/lib/models"
import { useShareReceiver } from "@/lib/share"
import { toHex } from "@/lib/theme"
import { useChatLayout } from "@/lib/chat-layout"
import { NewRoomScreen } from "@/components/room/new-room-screen"
import { ChatPage } from "@/routes/chat"
import { SetupGate } from "@/routes/setup"

// Only a chat is on the startup path; every other screen loads when it's first opened.
const SideChatsPage = lazy(() =>
  import("@/routes/side-chats").then((m) => ({ default: m.SideChatsPage })),
)
const OpenSessionPage = lazy(() =>
  import("@/routes/open-session").then((m) => ({ default: m.OpenSessionPage })),
)
const CodePage = lazy(() => import("@/routes/code").then((m) => ({ default: m.CodePage })))
const ProjectsPage = lazy(() =>
  import("@/routes/projects").then((m) => ({ default: m.ProjectsPage })),
)
const ProjectPage = lazy(() => import("@/routes/project").then((m) => ({ default: m.ProjectPage })))
const MeetingsPage = lazy(() =>
  import("@/routes/meetings").then((m) => ({ default: m.MeetingsPage })),
)
const MeetingPage = lazy(() =>
  import("@/routes/meetings").then((m) => ({ default: m.MeetingPage })),
)
const TopicPage = lazy(() => import("@/routes/meetings").then((m) => ({ default: m.TopicPage })))
const CanvasGate = lazy(() =>
  import("@/routes/canvas").then((m) => ({ default: m.CanvasGate })),
)
const CanvasPage = lazy(() =>
  import("@/routes/canvas").then((m) => ({ default: m.CanvasPage })),
)
const CanvasView = lazy(() => import("@/routes/canvas").then((m) => ({ default: m.CanvasView })))
const CanvasEdit = lazy(() => import("@/routes/canvas").then((m) => ({ default: m.CanvasEdit })))
const ResearchPage = lazy(() =>
  import("@/routes/research").then((m) => ({ default: m.ResearchPage })),
)
const MissionPage = lazy(() =>
  import("@/routes/research").then((m) => ({ default: m.MissionPage })),
)
const RoutinesPage = lazy(() =>
  import("@/routes/routines").then((m) => ({ default: m.RoutinesPage })),
)
/** The address the sidebar's row used to open: the active bot's routines, in its place. */
const RoutinesHome = lazy(() =>
  import("@/routes/routines").then((m) => ({ default: m.RoutinesHome })),
)
const SharePage = lazy(() => import("@/routes/share").then((m) => ({ default: m.SharePage })))
const SettingsPage = lazy(() =>
  import("@/routes/settings").then((m) => ({ default: m.SettingsPage })),
)
const ChatNextPage = lazy(() =>
  import("@/chat-next/page").then((m) => ({ default: m.ChatNextPage })),
)
const MarkdownDemoPage = lazy(() =>
  import("@/routes/demos/markdown").then((m) => ({ default: m.MarkdownDemoPage })),
)
const OpenUIReferencePage = lazy(() =>
  import("@/routes/docs/open-ui").then((m) => ({ default: m.OpenUIReferencePage })),
)

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

/** Home is the selected bot's screen: its entry, which lands on the bot's Main chat. */
export function Home() {
  const layout = useChatLayout()
  const active = useLiveQuery(
    async () => (layout === "flat" ? ((await getActiveProfile()) ?? null) : null),
    [layout],
  )
  if (layout === undefined || (layout === "flat" && active === undefined)) return null
  return active ? <Navigate to={botMainPath(active.id)} replace /> : <ChatPage slot="route" />
}

/**
 * A bot's entry, which is a doorway rather than a screen: it lands on the bot's Main chat, taking that
 * chat's address in this entry's place so that back from Main is the app rather than this address
 * again. The entry is tagged with the bot it is a chat of, so the shell keeps the list's lane while
 * the row loads.
 *
 * A bot whose Main this device does not hold — a host that publishes none yet — keeps its Side Chat
 * List where the address stands rather than drawing a blank, and the answer is still out on the first
 * read, so nothing is drawn until it lands. Nothing is ever made here: the plugin is Main's only
 * writer.
 */
function BotMain() {
  const { profileId } = useParams()
  const layout = useChatLayout()
  const main = useBotMain(profileId ?? "")
  if (layout === undefined) return null
  // A device on the Recents layout draws no bot's screen at all, so a bot's addresses still fall back
  // home there — the one gate the flat list keeps until the switch means the layout under it.
  if (layout !== "flat" || !profileId) return <Navigate to="/" replace />
  if (main === undefined) return null
  if (!main) return <SideChatsPage />
  return <Navigate to={`/c/${main}`} replace state={{ bot: profileId }} />
}

/** A project's old address, from before projects had a place of their own. */
function MovedProject() {
  const { profileId, projectId } = useParams()
  return <Navigate to={`/projects/${profileId}/${projectId}`} replace />
}

/** The app's screens behind the setup gate, which is what a test mounts to drive the real routing. */
export function AppRoutes() {
  useShareReceiver()
  // The model sheet reads the models.dev catalog on every open, so warm it here: a returning
  // user's facts refresh in the background without the sheet fetching. The scores need no warm of
  // their own — the payload they come from ships with the build.
  useEffect(() => {
    void warmCatalog()
  }, [])
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        {/* A bot's entry is a doorway onto its Main; its list has an address of its own. */}
        <Route path="b/:profileId" element={<BotMain />} />
        <Route path="b/:profileId/sidechats" element={<SideChatsPage />} />
        <Route path="b/:profileId/routines" element={<RoutinesPage />} />
        <Route path="c/:id" element={<ChatPage slot="route" />} />
        {/* A room that does not exist yet: its first send makes it (ADR 0125). */}
        <Route path="new-room" element={<NewRoomScreen slot="route" />} />
        <Route path="s/:sessionId" element={<OpenSessionPage />} />
        <Route path="code" element={<CodePage />} />
        <Route path="code/:profileId/:projectId" element={<MovedProject />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:profileId/:projectId" element={<ProjectPage />} />
        <Route path="meetings" element={<MeetingsPage />} />
        <Route path="meetings/:id" element={<MeetingPage />} />
        <Route path="meetings/:id/topics/:topic" element={<TopicPage />} />
        <Route path="routines" element={<RoutinesHome />} />
        <Route
          path="canvas"
          element={
            <CanvasGate>
              <CanvasPage />
            </CanvasGate>
          }
        />
        <Route
          path="canvas/:id"
          element={
            <CanvasGate>
              <CanvasView />
            </CanvasGate>
          }
        />
        <Route
          path="canvas/:id/edit"
          element={
            <CanvasGate>
              <CanvasEdit />
            </CanvasGate>
          }
        />
        <Route path="research" element={<ResearchPage />} />
        <Route path="research/:id" element={<MissionPage />} />
        <Route path="settings/:section?/:botId?/:tab?/:sub?/:leaf?" element={<SettingsPage />} />
        <Route path="share" element={<SharePage />} />
        <Route path="demos/markdown" element={<MarkdownDemoPage />} />
        <Route path="docs/open-ui" element={<OpenUIReferencePage />} />
        {import.meta.env.DEV ? <Route path="next" element={<ChatNextPage />} /> : null}
        <Route path="*" element={<ChatPage slot="route" />} />
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
