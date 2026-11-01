/**
 * The limit notice's place and its form: it stands inside the composer's box, above the text, and
 * carries no icon — its first line wears the tone the account's state calls for, and the reset line
 * sits under it. Which window decides, and the countdown's words, are the pure rule's
 * (`limitNotice` and `resetsInText` in `src/lib/provider-usage.ts`); what this holds is the render
 * and the place the composer gives it, which a DOM alone can change (ADR 0077).
 */
import assert from "node:assert/strict"
import test from "node:test"

import { Composer } from "@/components/chat/composer"
import { LimitNotice } from "@/components/chat/chat-actions"
import { PreviewerProvider } from "@/components/chat/previewer"
import type { ProviderUsage } from "@/lib/hermes"
import { limitNotice } from "@/lib/provider-usage"

import { atWidth, connection, find, findAll, mount } from "./component-kit.tsx"

const DAY = 24 * 60 * 60 * 1000
const bot = connection("limit-notice")

/** The account as the plugin answers it: one monthly period, `usedPercent` spent. */
const account = (usedPercent: number, resetsAt = Date.now() + 3 * DAY): ProviderUsage => ({
  provider: "openrouter",
  windows: [{ label: "Monthly", usedPercent, resetsAt }],
  at: Date.now(),
})

const composer = (element: ProviderUsage) => (
  <PreviewerProvider>
    <Composer
      busy={false}
      notice={
        <LimitNotice
          usage={{ notice: limitNotice(element), provider: "openrouter", noticeDismissed: false }}
          profileId="bot-1"
          onView={() => undefined}
        />
      }
      onSend={() => undefined}
      onQueue={() => undefined}
      onStop={() => undefined}
      onCommand={() => undefined}
      connection={bot}
      filesFeature="yes"
      imagesAvailable
    />
  </PreviewerProvider>
)

const noticeText = () => find("[data-slot=alert]")?.textContent ?? ""

test(
  "a phone's notice stands in the composer's box, above its text, with no icon",
  atWidth(390, async () => {
    await mount(composer(account(95)), async () => {
      const group = find("[data-slot=input-group]")
      const alert = find("[data-slot=alert]")
      const field = find("textarea")
      assert.ok(group && alert && field, "the composer drew its box, its field and the notice")
      assert.ok(group.contains(alert), "the notice is inside the composer's box, not above it")
      assert.ok(
        alert.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING,
        "and above the text it is about",
      )
      // The leading icon is what the tone and the words stand in for.
      assert.equal(findAll("[data-slot=alert] > svg").length, 0, "no icon leads the notice")
      assert.equal(
        findAll("[data-slot=alert] button svg").length,
        1,
        "the only icon left is the dismiss's",
      )
      // A phone's notice leaves the window's name out; the sheet names every window.
      assert.match(noticeText(), /^Approaching Limit/, "the line states the warning alone")
      assert.match(noticeText(), /Resets in \d/, "and the countdown under it")
      assert.doesNotMatch(noticeText(), /Monthly/, "the window's name is the sheet's to say")
      assert.ok(
        find("[data-slot=alert] .text-warning-ink"),
        "the first line wears the approaching tone",
      )
    })
  }),
)

test(
  "a tablet's notice names the window, and an account that is out wears the error tone",
  atWidth(768, async () => {
    await mount(composer(account(100)), async () => {
      assert.match(noticeText(), /^Monthly Limit Reached/, "the window is named at 768px and out")
      assert.ok(
        find("[data-slot=alert] .text-destructive-ink"),
        "and the line wears the error tone rather than a second icon",
      )
    })
  }),
)

test("an account with room to spare draws no notice, and the field stays", async () => {
  await mount(composer(account(40)), async () => {
    assert.equal(findAll("[data-slot=alert]").length, 0, "no notice is drawn")
    assert.ok(find("textarea"), "and the field is still the composer's")
  })
})
