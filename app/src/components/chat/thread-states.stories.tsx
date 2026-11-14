/**
 * The thread's own parts in each state they take: a bot's faces, approvals and questions waiting and
 * answered, pull request pills by state and checks, the status line, dividers and the cards that stand
 * where the composer would.
 */
import type { Meta, StoryObj } from "@storybook/react-vite"
import { MemoryRouter } from "react-router"

import { Bot } from "@/components/bot"
import { BOTS } from "@/components/bots"
import { ApprovalCard } from "@/components/chat/approval-card"
import { Divider } from "@/components/chat/divider"
import { EmptyChatState } from "@/components/chat/empty-states"
import { Compacted, ModelChange } from "@/components/chat/model-change"
import { PrPill } from "@/components/chat/pr-pill"
import { QuestionCard } from "@/components/chat/question-card"
import { BlockedCard, DiscardedCard, ResolvedCard } from "@/components/chat/session-cards"
import { StatusLine } from "@/components/chat/status-line"
import type { Message, PrChecks, PrState } from "@/lib/db"

const meta = {
  title: "Thread",
  decorators: [
    (Story) => (
      <MemoryRouter>
        <Story />
      </MemoryRouter>
    ),
  ],
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const reply = (extra: Partial<Message>): Message => ({
  id: "m",
  conversationId: "c",
  role: "assistant",
  content: "",
  status: "streaming",
  createdAt: 1,
  ...extra,
})

const noop = async () => {}

const approval = (resolved?: "once" | "deny" | "expired") =>
  reply({
    tools: [{ tool: "terminal", label: "Running a command", status: "running" }] as never,
    approval: {
      runId: "r",
      command: "rm -rf node_modules && pnpm install",
      description: "Delete and reinstall the dependencies",
      choices: ["once", "session", "always", "deny"],
      resolved,
    },
  })

export const BotFaces: Story = {
  render: () => (
    <div className="flex flex-wrap gap-6">
      {BOTS.map((one) => (
        <div key={one.id} className="flex flex-col items-center gap-1 text-sm">
          <Bot id={one.id} className="size-20" />
          {one.name}
        </div>
      ))}
    </div>
  ),
}

export const ApprovalWaiting: Story = {
  render: () => <ApprovalCard message={approval()} onAnswer={noop} />,
}
export const ApprovalAllowed: Story = {
  render: () => <ApprovalCard message={approval("once")} onAnswer={noop} />,
}
export const ApprovalDenied: Story = {
  render: () => <ApprovalCard message={approval("deny")} onAnswer={noop} />,
}
export const ApprovalExpired: Story = {
  render: () => <ApprovalCard message={approval("expired")} onAnswer={noop} />,
}

const question = (
  questions: { id: string; question: string; choices?: string[]; multiSelect?: boolean }[],
) => reply({ clarify: { runId: "r", clarifyId: "k", questions } })

export const QuestionWithChoices: Story = {
  render: () => (
    <QuestionCard
      onAnswer={noop}
      message={question([
        {
          id: "q0",
          question: "Which branch should the work start from?",
          choices: ["main", "develop"],
        },
      ])}
    />
  ),
}
export const QuestionOpenEnded: Story = {
  render: () => (
    <QuestionCard
      onAnswer={noop}
      message={question([{ id: "q0", question: "What should the release be called?" }])}
    />
  ),
}
export const QuestionPaged: Story = {
  render: () => (
    <QuestionCard
      onAnswer={noop}
      message={question([
        {
          id: "q0",
          question: "Which checks should run?",
          choices: ["Lint", "Tests", "Build"],
          multiSelect: true,
        },
        { id: "q1", question: "Open the pull request as a draft?", choices: ["Yes", "No"] },
      ])}
    />
  ),
}

const pr = (state: PrState, checks: PrChecks | null) => ({
  repo: "acme/app",
  number: 12,
  title: "Add the outputs pill",
  state,
  checks,
  url: "https://github.com/acme/app/pull/12",
  at: 1,
})

export const PullRequests: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <PrPill pr={pr("open", "success")} label="Open #12" />
      <PrPill pr={pr("open", "pending")} label="Checks running #12" />
      <PrPill pr={pr("open", "failure")} label="Checks failed #12" />
      <PrPill pr={pr("draft", null)} label="Draft #12" />
      <PrPill pr={pr("merged", null)} label="Merged #12" />
      <PrPill pr={pr("closed", null)} label="Closed #12" />
    </div>
  ),
}

export const StatusLines: Story = {
  render: () => (
    <div className="flex flex-col gap-1">
      <StatusLine text="Thinking" seed="a" />
      <StatusLine text="Writing" seed="b" />
      <StatusLine text="Waiting for your answer" />
      <StatusLine text="Ran 3 commands" />
    </div>
  ),
}

export const Dividers: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <ModelChange model="anthropic/claude-sonnet" />
      <Compacted compaction={{ tokens: 168000, window: 200000 }} />
      <Compacted />
      <Divider text="Today" />
    </div>
  ),
}

export const ComposerReplacements: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <BlockedCard reason="A repository this session works in was removed." />
      <ResolvedCard onReopen={() => {}} />
      <DiscardedCard />
    </div>
  ),
}

export const EmptyConfigured: Story = {
  render: () => (
    <div className="h-[420px]">
      <EmptyChatState botId="cubby" configured onSend={noop} />
    </div>
  ),
}
export const EmptyNotConfigured: Story = {
  render: () => (
    <div className="h-[420px]">
      <EmptyChatState botId="cubby" configured={false} />
    </div>
  ),
}
export const EmptyProjectSession: Story = {
  render: () => (
    <div className="h-[420px]">
      <EmptyChatState
        botId="cubby"
        configured
        session={{
          repos: [
            { name: "acme/app", branch: "main", base: true },
            { name: "acme/docs", branch: "main", base: true },
          ],
        }}
      />
    </div>
  ),
}
