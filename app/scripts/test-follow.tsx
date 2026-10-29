/**
 * Where the thread's end follows the reader: sending jumps back to it even from a scrolled-up read,
 * and so does answering the card that took the composer's place. Both chat screens draw these, so
 * the test draws them alone over a scroller whose box has something to scroll.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { useState } from "react"

import { FollowAfterApproval, FollowOnSend } from "@/components/chat/follow"
import {
  MessageScroller,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { click, findAll, mount } from "./component-kit.tsx"

function Thread() {
  const [last, setLast] = useState("u1")
  const [pending, setPending] = useState(false)
  return (
    <MessageScrollerProvider defaultScrollPosition="start">
      <MessageScroller>
        <MessageScrollerViewport aria-label="Messages">
          <button data-send onClick={() => setLast("u2")}>
            send
          </button>
          <button data-ask onClick={() => setPending(true)}>
            ask
          </button>
          <button data-answer onClick={() => setPending(false)}>
            answer
          </button>
        </MessageScrollerViewport>
        <FollowAfterApproval pending={pending} />
        <FollowOnSend lastUserId={last} />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}

/** Records what the scroller does to its box, which has room to move. */
function watch() {
  const moves: number[] = []
  const proto = HTMLElement.prototype as unknown as { scrollTo?: unknown }
  const had = "scrollTo" in proto
  const original = proto.scrollTo
  const height = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")
  Object.defineProperty(Element.prototype, "scrollHeight", { configurable: true, value: 5_000 })
  proto.scrollTo = function (options: ScrollToOptions | number) {
    moves.push(typeof options === "number" ? options : (options.top ?? 0))
  }
  return {
    moves,
    stop() {
      if (had) proto.scrollTo = original
      else delete proto.scrollTo
      if (height) Object.defineProperty(Element.prototype, "scrollHeight", height)
      else delete (Element.prototype as unknown as { scrollHeight?: number }).scrollHeight
    },
  }
}

const press = (selector: string) => click(findAll(selector)[0] ?? null)

test("a send jumps back to the end of the thread, and an answered card follows the reply on", async () => {
  const seen = watch()
  try {
    await mount(<Thread />, async () => {
      const before = seen.moves.length
      await press("[data-send]")
      assert.ok(seen.moves.length > before, "a new request of the user's scrolls to the end")
      await press("[data-ask]")
      const asked = seen.moves.length
      await press("[data-answer]")
      assert.ok(seen.moves.length > asked, "answering the card scrolls to the end")
    })
  } finally {
    seen.stop()
  }
})
