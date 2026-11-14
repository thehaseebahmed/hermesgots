/**
 * The app's screens as the app draws them: its own route table over a seeded device, at a phone's and
 * a laptop's width. A story is a state of a screen — empty, filled, the host away — and the Viewport
 * toolbar changes the width.
 */
import type { Meta, StoryObj } from "@storybook/react-vite"
import { MemoryRouter } from "react-router"

import { AppRoutes } from "@/App"
import { BOTS, onDevice, type Device, type DeviceChat } from "./device"

interface ScreenArgs {
  route: string
}

const meta = {
  title: "Screens",
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
        <Story />
      </div>
    ),
  ],
  render: (args) => (
    <MemoryRouter initialEntries={[args.route]}>
      <AppRoutes />
    </MemoryRouter>
  ),
} satisfies Meta<ScreenArgs>

export default meta
type Story = StoryObj<typeof meta>

const PHONE = { viewport: { value: "mobile1", isRotated: false } }
const LAPTOP = { viewport: { value: "desktop", isRotated: false } }

const chats: DeviceChat[] = [
  {
    id: "c1",
    bot: "bot-cubby",
    title: "Plan the migration",
    ago: 3,
    messages: [
      { role: "user", content: "Plan the migration in three checkpoints." },
      { role: "assistant", content: "Add the table, backfill it, then switch reads over." },
    ],
  },
  { id: "c2", bot: "bot-cubby", title: "Tidy the changelog", ago: 90 },
  { id: "c3", bot: "bot-cubby", title: "Why is the build red?", ago: 60 * 26 },
]

const working: DeviceChat[] = [
  {
    id: "w1",
    bot: "bot-cubby",
    title: "Run the tests",
    ago: 2,
    messages: [
      { role: "user", content: "Run the tests and tell me what fails." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "terminal", arguments: '{"command":"pnpm test"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        tool_name: "terminal",
        content: '{"output":"2 failing","exit_code":1}',
      },
      {
        role: "assistant",
        content:
          "Two tests fail:\n\n1. `chat-list` ordering\n2. `sort` direction\n\nShall I fix them?",
      },
    ],
  },
]

const sessions: DeviceChat[] = [
  { id: "s1", bot: "bot-cubby", title: "Add the outputs pill", ago: 4, projectId: "p1" },
  { id: "s2", bot: "bot-cubby", title: "Fix the sort arrow", ago: 120, projectId: "p1" },
]

const screen = (route: string, device: Device, globals = PHONE): Story => ({
  args: { route },
  globals,
  loaders: [onDevice(device)],
})

export const ChatListPhone = screen("/b/bot-cubby", { chats })
export const ChatListLaptop = screen("/b/bot-cubby", { chats }, LAPTOP)
export const ChatListEmpty = screen("/b/bot-cubby", { chats: [] })
export const ChatListHostAway = screen("/b/bot-cubby", { chats, host: "away" })
export const OpenChat = screen("/c/c1", { chats })
export const OpenChatLaptop = screen("/c/c1", { chats }, LAPTOP)
export const OpenChatWithTools = screen("/c/w1", { chats: working })
export const OpenChatWithToolsLaptop = screen("/c/w1", { chats: working }, LAPTOP)
export const BlankChat = screen("/c/new-story-chat", { chats: [] })
export const SettingsPhone = screen("/settings", {})
export const SettingsLaptop = screen("/settings", {}, LAPTOP)
export const SettingsWithoutDeveloper = screen("/settings", { settings: { developer: false } })
export const BotSettings = screen("/settings/bots/bot-cubby", {})
export const Developer = screen("/settings/developer", {})
export const Appearance = screen("/settings/appearance", {})
export const CodeWithSessions = screen("/code", { chats: sessions })
export const CodeEmpty = screen("/code", { chats: [] })
export const ProjectsEmpty = screen("/projects", {})
export const ProjectsHostAway = screen("/projects", { host: "away" })
export const ResearchEmpty = screen("/research", {})
export const Routines = screen("/b/bot-cubby/routines", {})
export const OneBotOnly = screen("/b/bot-cubby", { bots: [BOTS[0]], chats })
