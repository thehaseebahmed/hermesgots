/**
 * The chat body (`chat-next/chat-body.tsx`): one chat's thread, composer, pills and limit context in
 * whatever flex column holds it, with no route param, pane slot or header. This pins what a canvas's
 * sheet will rely on: mounted by itself over a seeded chat and its faked host, a send runs a turn and
 * its reply lands in the thread.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter } from "react-router"

import { ChatBody } from "@/chat-next/chat-body"
import { db } from "@/lib/db"
import { PreviewerProvider } from "@/components/chat/previewer"

import { fakeHost } from "./chat-next-host.ts"
import {
  botProfile,
  click,
  composerField,
  find,
  findAll,
  mount,
  seedChats,
  settle,
  type,
} from "./component-kit.tsx"

const bot = botProfile("hermes")

async function until(check: () => boolean, what: string) {
  const by = Date.now() + 6_000
  while (!check() && Date.now() < by) {
    await settle()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)))
  }
  assert.ok(check(), what)
}

const replies = () =>
  findAll('[data-slot="message"][data-align="start"] [data-slot="markdown"]').map(
    (one) => one.textContent,
  )

test("the body draws a seeded chat in a plain container and a send runs a turn", async () => {
  const defaultPick = { provider: "anthropic", model: "claude-sonnet-5-5" }
  await seedChats([{ id: "c-body", title: "Sky colours" }], {
    bots: [{ ...bot, baseUrl: "http://c-body.test/v1", modelChoice: defaultPick }],
    settings: { chatNext: true },
  })
  const host = fakeHost("gots-c-body", { plugin: false })
  const chat = (await db.conversations.get("c-body"))!
  const profile = (await db.profiles.get(chat.profileId))!
  await mount(
    <MemoryRouter>
      <PreviewerProvider>
        <div data-testid="holder" className="flex h-[480px] min-h-0 flex-col">
          <ChatBody
            chat={chat}
            bot={profile}
            summaries={new Set()}
            start={undefined}
            onAway={() => {}}
            limit={{
              usage: { notice: null, provider: undefined, noticeDismissed: false },
              onView: () => {},
            }}
          />
        </div>
      </PreviewerProvider>
    </MemoryRouter>,
    async () => {
      await until(() => Boolean(composerField()), "the composer is drawn in the container")
      assert.equal(find('[data-slot="header-title"]'), null, "the body draws no header")
      await type(composerField(), "Why is the sky blue?")
      await click(find('button[aria-label="Send"]'))
      await until(() => host.asked.runs === 1, "the host was asked to run the message")
      assert.equal(host.latest.body!.session_id, "gots-c-body", "the chat's own session")
      assert.deepEqual(
        { provider: host.latest.body!.provider, model: host.latest.body!.model },
        defaultPick,
        "on the bot's pick",
      )
      host.latest.run!.finish("Rayleigh scattering.")
      await until(() => replies().includes("Rayleigh scattering."), "the reply lands in the thread")
      assert.ok(
        find('[data-testid="holder"]')?.contains(composerField() ?? null),
        "the composer sits inside the container it was given",
      )
    },
  )
})
