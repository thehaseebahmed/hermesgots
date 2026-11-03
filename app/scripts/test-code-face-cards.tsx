/**
 * The code face's reach into a card (ADR 0087): in a project session the bot's own words inside a
 * card read in the face — a question and its choices, an approval's description — while the app's
 * words around them keep the app's: the title, the buttons, the counts.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { ApprovalCard } from "@/components/chat/approval-card"
import { CODE_FACE, CodeFaceProvider } from "@/components/chat/code-face"
import { QuestionCard } from "@/components/chat/question-card"
import type { Message } from "@/lib/db"

import { find, findAll, mount } from "./component-kit.tsx"

/** Whether an element reads in the code face, from itself or any ancestor. */
const inFace = (element: Element | null) => Boolean(element?.closest(`.${CODE_FACE}`))

const asked: Message = {
  id: "m-ask",
  conversationId: "c-1",
  role: "assistant",
  content: "",
  status: "waiting",
  createdAt: 1,
  clarify: {
    id: "q-1",
    resolved: false,
    questions: [
      {
        id: "q0",
        question: "Which branch should I work on?",
        choices: ["main", "release"],
        multiSelect: false,
      },
    ],
  },
}

const askedApproval: Message = {
  id: "m-approve",
  conversationId: "c-1",
  role: "assistant",
  content: "",
  status: "waiting",
  createdAt: 1,
  approval: {
    id: "a-1",
    description: "Write the file where the build reads it.",
    command: "npm run build",
    choices: ["once", "session", "always", "deny"],
    resolved: undefined,
  },
  tools: [{ toolCallId: "call-1", tool: "terminal", status: "running", startedAt: 1 }],
}

const session = (node: React.ReactNode) => <CodeFaceProvider value={CODE_FACE}>{node}</CodeFaceProvider>

test("a question's own words read in the session's face, its title and buttons do not", async () => {
  await mount(session(<QuestionCard message={asked} onAnswer={async () => {}} />), async () => {
    const question = find('[data-question-page] p') ?? findAll("p")[0]
    assert.equal(inFace(question), true, "the question itself")
    const choice = findAll("span").find((one) => one.textContent === "main") ?? null
    assert.equal(inFace(choice), true, "and the choices it offers")
    const title = find('[data-slot="card-title"]') ?? findAll("span").find((one) => one.textContent === "Question")
    assert.equal(inFace(title), false, "while the card's own title stays in the app's face")
  })
})

test("an approval's sentence reads in the face, its command is code and its title is not", async () => {
  await mount(session(<ApprovalCard message={askedApproval} onAnswer={async () => {}} />), async () => {
    const said = findAll("p").find((one) => one.textContent === askedApproval.approval!.description)
    assert.equal(inFace(said ?? null), true, "the bot's sentence about what it wants to do")
    const command = find("[data-md-code]")
    assert.ok(command?.textContent?.includes("npm run build"), "the command in the reply's code block")
    assert.equal(find('[data-slot="card-title"]')?.textContent?.includes("Approval needed"), true)
  })
})

test("a chat's cards keep the app's face throughout", async () => {
  await mount(<QuestionCard message={asked} onAnswer={async () => {}} />, async () => {
    assert.equal(document.querySelector(`.${CODE_FACE}`), null, "a chat has no code face at all")
  })
})
