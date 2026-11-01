/**
 * What Enter does in the composer, by the device's Send on Enter switch: off by default, so the plain
 * key is left to the field — a newline — and the chord (Ctrl or Cmd) sends; on, the key sends and
 * Shift keeps its line. The slash menu still takes the bare key as its pick, whichever the switch
 * says, and the field's keyboard hint follows the switch too.
 *
 * `defaultPrevented` is what the app can be held to for the line: jsdom performs no default action,
 * so a value left in the field proves nothing. That a browser really inserts it is `chat-message`'s.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { Composer } from "@/components/chat/composer"

import {
  composerField,
  connection,
  findAll,
  json,
  mount,
  pickPress,
  pressEnter,
  sendPress,
  type,
  until,
} from "./component-kit.tsx"

const bot = connection("composer-enter")

type Sent = { sent: string[]; steer: string[]; commands: string[] }

function composer({
  sent,
  sendOnEnter = false,
  busy = false,
}: {
  sent: Sent
  sendOnEnter?: boolean
  busy?: boolean
}) {
  return (
    <Composer
      busy={busy}
      sendOnEnter={sendOnEnter}
      canSteer={busy}
      onSend={(text) => sent.sent.push(text)}
      onQueue={(text) => sent.sent.push(text)}
      onSteer={(text) => sent.steer.push(text)}
      onStop={() => {}}
      onCommand={(command) => sent.commands.push(command)}
      connection={bot}
      filesFeature="yes"
      imagesAvailable
    />
  )
}

const empty = (): Sent => ({ sent: [], steer: [], commands: [] })

test("off, a plain Enter is left to the field and nothing is sent", async () => {
  const sent = empty()
  await mount(composer({ sent }), async () => {
    await type(composerField(), "two lines")
    const event = await pressEnter()
    assert.equal(event.defaultPrevented, false, "the browser keeps the key, so it inserts a line")
    assert.deepEqual(sent.sent, [], "and nothing goes to the bot")
  })
})

test("off, the chord sends what the field holds, on a PC or a Mac", async () => {
  const sent = empty()
  await mount(composer({ sent }), async () => {
    for (const chord of [{ ctrlKey: true }, { metaKey: true }]) {
      await type(composerField(), "send me")
      const event = await pressEnter(chord)
      assert.equal(event.defaultPrevented, true, "the chord is never a line")
      assert.equal(sent.sent.at(-1), "send me", "and it sends")
    }
    assert.equal(sent.sent.length, 2, "once per chord")
  })
})

test("on, Enter sends and the field is emptied", async () => {
  const sent = empty()
  await mount(composer({ sent, sendOnEnter: true }), async () => {
    await type(composerField(), "one line")
    const event = await pressEnter()
    assert.equal(event.defaultPrevented, true, "the key is the send, so no line lands")
    assert.deepEqual(sent.sent, ["one line"])
    assert.equal(composerField()?.value, "", "the message leaves the field")
  })
})

test("on, Shift+Enter is still the line", async () => {
  const sent = empty()
  await mount(composer({ sent, sendOnEnter: true }), async () => {
    await type(composerField(), "one line")
    const event = await pressEnter({ shiftKey: true })
    assert.equal(event.defaultPrevented, false)
    assert.deepEqual(sent.sent, [])
  })
})

test("the field's keyboard hint says what the key does", async () => {
  const sent = empty()
  await mount(composer({ sent }), async () =>
    assert.equal(composerField()?.getAttribute("enterkeyhint"), "enter"),
  )
  await mount(composer({ sent, sendOnEnter: true }), async () =>
    assert.equal(composerField()?.getAttribute("enterkeyhint"), "send"),
  )
})

/** The host the composer asks, answering one runnable skill, so a slash token really opens a menu. */
function host() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/plugins/memento/info")) return json({ features: ["skills"] })
    if (url.pathname.endsWith("/plugins/memento/skills"))
      return json({
        object: "list",
        data: [
          {
            name: "log-triage",
            description: "Find the noisy lines.",
            category: "ops",
            origin: "builtin",
          },
        ],
      })
    return json({})
  }) as typeof fetch
}

const menuOpen = () => findAll('[role="option"]').length > 0

/** The composer with its slash menu really open: the caret inside a token one skill answers. */
async function withMenu(sent: Sent, body: () => Promise<void>) {
  host()
  await mount(composer({ sent }), async () => {
    await until(async () => Boolean(composerField()), "the composer")
    await type(composerField(), "/log-triage")
    await until(menuOpen, "the menu, with the skill on it")
    await body()
  })
}

test("with the menu open, the bare key is the menu's pick", async () => {
  const sent = empty()
  await withMenu(sent, async () => {
    await pickPress()
    assert.match(composerField()?.value ?? "", /log-triage/, "the skill landed in the field")
    assert.deepEqual(sent.sent, [], "and nothing was sent")
  })
})

test("with the menu open, the chord sends the words rather than picking", async () => {
  const sent = empty()
  await withMenu(sent, async () => {
    await sendPress()
    assert.deepEqual(sent.sent, ["/log-triage"], "the words reached the bot, unpicked")
  })
})
