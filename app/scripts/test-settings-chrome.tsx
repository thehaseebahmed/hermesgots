/**
 * The settings chrome's two pieces: the Screen header's action slot, drawn beside the title and
 * absent when a screen passes none, and the split switch row, whose left column opens what it names
 * while the switch in the column beside it toggles on its own.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act, useState, type ReactNode } from "react"

import { PlusIcon, SparklesIcon, Trash2Icon } from "lucide-react"

import { Screen, SplitSwitchRow, useHeaderAction } from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { click, find, findAll, mount, settle } from "./component-kit.tsx"

const TITLE = "Code review"
const SUBTITLE = "Reviews a change before it ships"
const EXTRA = "Last checked: never"

/** What a control is called: its label where it has one, the words it shows where it doesn't. */
const name = (element: Element) =>
  element.getAttribute("aria-label") ?? (element.textContent ?? "").trim()
/**
 * What a screen reader calls it: the words of whatever `aria-labelledby` points at, or its own label.
 * The switch is a span, so this is the name its caller's words have to reach it by.
 */
const spoken = (element: Element | null) => {
  if (!element) return ""
  const ids = element.getAttribute("aria-labelledby")
  const pointed = ids
    ? ids
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .join(" ")
        .trim()
    : ""
  return (
    pointed ||
    (element.getAttribute("aria-label") ?? "").trim() ||
    (element.textContent ?? "").trim()
  )
}
const named = (selector: string, label: string) =>
  findAll(selector).find((one) => name(one) === label) ?? null
const namedWith = (selector: string, label: string) =>
  findAll(selector).find((one) => name(one).includes(label)) ?? null

/** A key press, the way a keyboard sends one to the control that holds the focus. */
async function press(element: Element, key: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
    element.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }))
  })
  await settle()
}

const screen = (action?: ReactNode) => (
  <Screen title="Bot" action={action}>
    <p>A setting</p>
  </Screen>
)

const pressed: number[] = []

/** A page that offers its own action in the header of the Screen it renders under. */
function PageWithAction({ offer = true, clicks }: { offer?: boolean; clicks: number[] }) {
  useHeaderAction(
    "add",
    offer ? (
      <Button
        variant="outline"
        size="icon-lg"
        className="size-11 rounded-full"
        aria-label="Add a server"
        onClick={() => clicks.push(1)}
      >
        <PlusIcon />
      </Button>
    ) : null,
  )
  return <p>The page's own settings</p>
}

/** The page, and the switch that takes it away again. */
function WithOrWithout() {
  const [on, setOn] = useState(true)
  return (
    <>
      <button type="button" onClick={() => setOn((value) => !value)}>
        {on ? "Take it away" : "Bring it back"}
      </button>
      <Screen title="MCP">{on ? <PageWithAction clicks={pressed} /> : <p>No page</p>}</Screen>
    </>
  )
}

test("a screen's action sits beside its title, and a screen that passes none draws none", async () => {
  pressed.length = 0
  await mount(
    screen(
      <Button
        variant="outline"
        size="icon-lg"
        className="size-11 rounded-full"
        aria-label="Delete bot"
        onClick={() => pressed.push(1)}
      >
        <Trash2Icon />
      </Button>,
    ),
    async () => {
      const heading = find("h1")
      assert.ok(heading, "the screen still heads itself with its title")
      assert.equal(heading.textContent, "Bot")

      const action = named("button", "Delete bot")
      assert.ok(action, "the action is on the screen, named for what it does")
      assert.equal(
        action.closest("header"),
        heading.closest("header"),
        "it sits in the header beside the title, not down in the settings",
      )
      assert.ok(
        heading.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING,
        "and comes after the title",
      )

      await click(action)
      assert.equal(pressed.length, 1, "and it is the screen's own control, tappable")
    },
  )

  await mount(screen(), async () => {
    assert.equal(find("header button"), null, "a screen given no action draws no control there")
    assert.equal(named("button", "Delete bot"), null, "and nothing named for one")
  })
})

const opened: number[] = []
const toggled: boolean[] = []

/** The split row as a screen holds it: checked is the caller's, so a toggle is the row's own doing. */
function SplitRow({ extra }: { extra?: ReactNode }) {
  const [checked, setChecked] = useState(false)
  return (
    <SplitSwitchRow
      icon={SparklesIcon}
      title={TITLE}
      subtitle={SUBTITLE}
      extra={extra}
      checked={checked}
      onOpen={() => opened.push(1)}
      onCheckedChange={(next) => {
        toggled.push(next)
        setChecked(next)
      }}
    />
  )
}

const column = () => namedWith("button", TITLE)
const switchOf = () => named('[role="switch"]', TITLE)

test("the left column opens the row and leaves the switch exactly where it was", async () => {
  opened.length = 0
  toggled.length = 0
  await mount(<SplitRow extra={EXTRA} />, async () => {
    const left = column()
    assert.ok(left, "the left column is a control of its own, named by the row's title")
    assert.match(left.textContent ?? "", new RegExp(TITLE), "titled")
    assert.match(left.textContent ?? "", new RegExp(SUBTITLE), "with its subtitle inside the tap")
    assert.match(left.textContent ?? "", /Last checked/, "and the extra line beneath it too")
    assert.equal(switchOf()?.getAttribute("aria-checked"), "false", "the switch starts off")

    await click(left)
    assert.equal(opened.length, 1, "the tap opened what the row names")
    assert.deepEqual(toggled, [], "and asked for no toggle")
    assert.equal(switchOf()?.getAttribute("aria-checked"), "false", "so the switch is still off")
  })
})

test("the switch toggles on its own and never opens the row", async () => {
  opened.length = 0
  toggled.length = 0
  await mount(<SplitRow />, async () => {
    assert.equal(switchOf()?.getAttribute("aria-checked"), "false", "off to start")

    await click(switchOf())
    assert.deepEqual(toggled, [true], "one tap asks for on")
    assert.equal(opened.length, 0, "and does not open the row beside it")
    assert.equal(switchOf()?.getAttribute("aria-checked"), "true", "the switch reads back on")

    await click(switchOf())
    assert.deepEqual(toggled, [true, false], "a second tap asks for off")
    assert.equal(opened.length, 0, "still without opening anything")

    // The whole right column is the switch's own: a tap on the padding beside it toggles it too.
    await click(find("label"))
    assert.deepEqual(toggled, [true, false, true], "and the column's own edge switches it")
    assert.equal(opened.length, 0, "never reaching the column beside it")
  })
})

test("both columns take the focus and say what they do", async () => {
  opened.length = 0
  toggled.length = 0
  await mount(<SplitRow extra={EXTRA} />, async () => {
    const left = column()
    assert.ok(left, "the left column is on the screen")
    assert.equal(left.tagName, "BUTTON", "a real button, so Enter and Space activate it")
    assert.equal(left.getAttribute("type"), "button", "and one that submits nothing")
    ;(left as HTMLElement).focus()
    assert.equal(document.activeElement, left, "the keyboard reaches the row's tap")
    assert.match(spoken(left), new RegExp(TITLE), "and it is announced by the row's title")

    const toggle = switchOf()
    assert.ok(toggle, "the switch is on the screen")
    ;(toggle as HTMLElement).focus()
    assert.equal(document.activeElement, toggle, "the keyboard reaches the switch too")
    assert.equal(spoken(toggle), TITLE, "announced as the setting it switches")

    // jsdom has no default activation for a native button, so the button is taken at its word
    // (a real <button>, so Enter and Space are the browser's) and the switch is driven by the keys
    // the primitive itself handles.
    await press(toggle, "Enter")
    assert.deepEqual(toggled, [true], "Enter on the switch switches it")
    assert.equal(opened.length, 0, "without opening the row")
  })

  // A row whose switch says something other than the title is announced by that instead.
  await mount(
    <SplitSwitchRow
      title={TITLE}
      switchLabel="Notify me about reviews"
      checked={false}
      onOpen={() => {}}
      onCheckedChange={() => {}}
    />,
    async () => {
      const toggle = named('[role="switch"]', "Notify me about reviews")
      assert.ok(toggle, "the switch is named for the words the caller gave it")
      assert.equal(spoken(toggle), "Notify me about reviews", "and that is what is read out")
    },
  )
})

test("a page offers its action in the header of the Screen that holds it", async () => {
  pressed.length = 0
  await mount(
    <Screen title="MCP">
      <PageWithAction clicks={pressed} />
    </Screen>,
    async () => {
      const action = named("button", "Add a server")
      assert.ok(action, "the page's own control is on screen")
      assert.equal(
        action.closest("header"),
        find("header"),
        "in that Screen's header, not down among the page's settings",
      )
      await click(action)
      assert.deepEqual(pressed, [1], "and it is the page's control, tappable")

      // The list beside a page has a header of its own, which the page must not reach into.
      assert.equal(
        findAll("header").length,
        1,
        "one Screen, one header holding the action",
      )
    },
  )
})

test("the action goes away with the page that offered it", async () => {
  pressed.length = 0
  await mount(<WithOrWithout />, async () => {
    assert.ok(named("button", "Add a server"), "the page is here, so its action is")
    await click(named("button", "Take it away"))
    assert.equal(named("button", "Add a server"), null, "the page is gone, and its action with it")
    await click(named("button", "Bring it back"))
    assert.ok(named("button", "Add a server"), "and it comes back with the page")
  })
})

test("a Screen's own action is the one it draws", async () => {
  pressed.length = 0
  await mount(
    <Screen title="Bot" action={<Button aria-label="Delete bot">delete</Button>}>
      <PageWithAction clicks={pressed} />
    </Screen>,
    async () => {
      assert.ok(named("button", "Delete bot"), "the screen's own action is drawn")
      assert.equal(
        named("button", "Add a server"),
        null,
        "and takes the place of anything its page offered",
      )
    },
  )
})
