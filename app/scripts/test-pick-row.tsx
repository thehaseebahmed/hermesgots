/**
 * The pick row and its group: one `<li>` holding one button and at most one sibling action, the state
 * its mode promises (a tick, a press, a chevron, a cursor), and the fill the surface it sits on
 * gives a chosen row. What a pick means, what it says and which list it is stay the caller's.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { PickGroup, PickRow } from "@/components/pick-row"
import { PrRow } from "@/components/pr-row"
import type { PullRequestRef } from "@/lib/db"
import { click, findAll, find, mount } from "./component-kit.tsx"

const noop = () => {}

const rows = (element: React.ReactNode) => <PickGroup mode="choose" label="Bots">{element}</PickGroup>

test("a group is one list, and a row is one item under it", async () => {
  await mount(
    rows(
      <>
        <PickRow title="Tri" onPick={noop} />
        <PickRow title="Cubby" onPick={noop} />
      </>,
    ),
    async () => {
      const list = find('ul[role="radiogroup"]')
      assert.ok(list, "the group is the radiogroup")
      assert.equal(list?.getAttribute("aria-label"), "Bots", "under the name it was given")
      assert.equal(findAll("ul > li").length, 2, "one item per row")
      assert.equal(findAll("ul > li > button").length, 2, "each item holds one button")
      assert.equal(
        findAll("[role=radio]").length,
        2,
        "and a choose group makes each button a radio",
      )
      assert.ok(!/min-h-14/.test(document.body.innerHTML), "no row is a list row's height")
    },
  )
})

test("a chosen row ticks, a toggle presses, an open row chevrons and ticks nothing", async () => {
  await mount(
    <>
      <PickGroup mode="choose" label="One" surface="plate">
        <PickRow title="Chosen" selected onPick={noop} />
      </PickGroup>
      <PickGroup mode="toggle" label="Two" surface="plate">
        <PickRow title="Armed" selected onPick={noop} />
      </PickGroup>
      <PickGroup mode="open" label="Three" surface="plate">
        <PickRow title="Elsewhere" selected onPick={noop} />
      </PickGroup>
    </>,
    async () => {
      const [chosen, armed, opens] = findAll("button")
      assert.equal(chosen?.getAttribute("aria-checked"), "true", "a choose row is checked")
      assert.equal(armed?.getAttribute("aria-pressed"), "true", "a toggle row is pressed")
      assert.equal(opens?.getAttribute("aria-checked"), null, "an open row claims no state")
      assert.equal(opens?.getAttribute("aria-pressed"), null, "and no press")
      assert.equal(findAll("svg[class*=check]").length, 2, "only the two stateful modes tick")
      assert.equal(findAll("svg[class*=chevron-right]").length, 1, "the open row points on")
    },
  )
})

test("a row's action sits beside its button, never inside it", async () => {
  await mount(
    <PickGroup mode="choose" label="Prompts">
      <PickRow
        title="House rules"
        onPick={noop}
        action={{ label: "Edit House rules", onPress: noop }}
      />
    </PickGroup>,
    async () => {
      const item = find("ul > li")
      assert.equal(item?.querySelectorAll(":scope > button").length, 2, "two buttons, side by side")
      assert.equal(
        item?.querySelector("button button"),
        null,
        "and never a button inside a button",
      )
      assert.ok(
        findAll("button").some((one) => one.getAttribute("aria-label") === "Edit House rules"),
        "the action is named for what it does",
      )
    },
  )
})

test("an option follows the cursor, and never claims to be chosen", async () => {
  const pressed: string[] = []
  await mount(
    <PickGroup mode="option" label="Commands">
      <PickRow title="/settings" id="row-0" active={false} onPick={noop} />
      <PickRow title="/review" id="row-1" active onPick={noop} />
    </PickGroup>,
    async () => {
      const [first, second] = findAll('button[role="option"]')
      assert.equal(first?.getAttribute("aria-selected"), "false", "the row above the cursor")
      assert.equal(second?.getAttribute("aria-selected"), "true", "the row the cursor is on")
      assert.equal(findAll("svg[class*=check]").length, 0, "a cursor is not a choice")
      assert.equal(second?.id, "row-1", "the id the field points at is on the option")
      second?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
      pressed.push(String(second?.id))
      assert.deepEqual(pressed, ["row-1"])
    },
  )
})

test("the chosen fill comes from the surface the row sits on", async () => {
  await mount(
    <>
      <PickGroup mode="choose" label="Plate" surface="plate">
        <PickRow title="On a plate" selected onPick={noop} />
      </PickGroup>
      <PickGroup mode="choose" label="Bare">
        <PickRow title="On the popover" selected onPick={noop} />
      </PickGroup>
    </>,
    async () => {
      const [onPlate, bare] = findAll("button")
      assert.match(onPlate?.className ?? "", /bg-background/, "a plate fills the row white")
      assert.match(bare?.className ?? "", /bg-muted/, "a bare list fills it grey")
      assert.doesNotMatch(
        onPlate?.className ?? "",
        /bg-muted(?![\w/-])/,
        "and a plate's row never wears the list's grey",
      )
    },
  )
})

test("a row's button fills its item, so the fill reaches both edges", async () => {
  await mount(
    <PickGroup mode="choose" label="Models">
      <PickRow title="claude-sonnet-4-5" line="200k" selected onPick={noop} />
    </PickGroup>,
    async () => {
      // `flex-1` alone leaves the button as wide as its words: a block that sits inside a list item
      // is filled by `w-full`, and the selected fill then paints the whole row rather than a pill.
      assert.match(find("li button")?.className ?? "", /\bw-full\b/, "the button spans its item")
      assert.doesNotMatch(find("li button")?.className ?? "", /inline-flex/, "and is not squeezed in")
    },
  )
})

test("a row with no group goes somewhere", async () => {
  await mount(<PickRow title="A pull request" onPick={noop} />, async () => {
    const button = find("button")
    assert.equal(button?.getAttribute("role"), null, "no role is promised")
    assert.equal(button?.getAttribute("aria-checked"), null, "no state is promised")
    assert.ok(find("svg[class*=chevron-right]"), "it points on")
    assert.equal(findAll("svg[class*=check]").length, 0, "and never ticks")
  })
})

test("a PR row opens on GitHub and never ticks", async () => {
  const opened: string[] = []
  const original = window.open
  window.open = ((url: string) => {
    opened.push(url)
    return null
  }) as typeof window.open
  const pr: PullRequestRef = {
    number: 28,
    repo: "mock-user/maze",
    url: "https://github.com/mock-user/maze/pull/28",
    state: "draft",
    checks: null,
    at: 1,
    title: "feat: add a dry-run flag",
  }
  try {
    await mount(
      <PickGroup mode="open" label="Pull requests">
        <PrRow pr={pr} />
      </PickGroup>,
      async () => {
        assert.match(document.body.textContent ?? "", /Draft · #28 · mock-user\/maze/)
        await click(find("button"))
        assert.deepEqual(opened, [pr.url], "the row opens the pull request")
        assert.equal(findAll("svg[class*=check]").length, 0, "and ticks nothing")
      },
    )
  } finally {
    window.open = original
  }
})
