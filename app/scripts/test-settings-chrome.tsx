/**
 * The settings chrome: the Screen header's action slot, drawn beside the title and absent when a
 * screen passes none; the split switch row, whose left column opens what it names while the switch in
 * the column beside it toggles on its own; and the pieces ADR 0055 added — the muted caption over a
 * card, the value row that shows a setting and opens its edit, the edit form that writes once on Save,
 * the pick surface with its list of buttons, and the list itself. Nothing here is a heading and
 * nothing here is a field sitting inside a card.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act, useState, type ReactNode } from "react"

import { PlusIcon, SparklesIcon, Trash2Icon } from "lucide-react"

import {
  Caption,
  EditForm,
  Group,
  PickList,
  PickSurface,
  Screen,
  SplitSwitchRow,
  ValueRow,
  useHeaderAction,
} from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import {
  absent,
  atWidth,
  click,
  find,
  findAll,
  laptop,
  mount,
  settle,
  text,
  type as typing,
} from "./component-kit.tsx"

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
    absent("header button", "a screen given no action draws no control there")
    assert.ok(!named("button", "Delete bot"), "and nothing named for one")
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
      assert.equal(findAll("header").length, 1, "one Screen, one header holding the action")
    },
  )
})

test("the action goes away with the page that offered it", async () => {
  pressed.length = 0
  await mount(<WithOrWithout />, async () => {
    assert.ok(named("button", "Add a server"), "the page is here, so its action is")
    await click(named("button", "Take it away"))
    assert.ok(!named("button", "Add a server"), "the page is gone, and its action with it")
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
      assert.ok(
        !named("button", "Add a server"),
        "and takes the place of anything its page offered",
      )
    },
  )
})

const ROW = "Server key"
const PURPOSE = "The key this app sends to that server"
const VALUE = "sk-live-123"

test("a caption names what a card holds without becoming a heading", async () => {
  await mount(
    <>
      <Caption>Bot Profile</Caption>
      <Group>
        <p>A row</p>
      </Group>
    </>,
    async () => {
      const caption = find("p")
      assert.ok(caption, "the caption is on the screen")
      assert.equal(caption.textContent, "Bot Profile", "in the words the page gave it")
      assert.equal(
        findAll("h1, h2, h3, h4, h5, h6").length,
        0,
        "and stays out of the document's headings: a card has no heading of its own",
      )
      assert.ok(!caption.closest('[role="heading"]'), "nothing announces it as a heading either")
    },
  )
})

test("a value row is its title over what it is for over its value", async () => {
  const taps: number[] = []
  await mount(
    <>
      <Group>
        <ValueRow
          title={ROW}
          purpose={PURPOSE}
          value={VALUE}
          onClick={() => taps.push(1)}
          data-setting="key"
        />
        <ValueRow title="Image" value="" onClick={() => taps.push(1)} data-setting="image" />
      </Group>
    </>,
    async () => {
      const row = namedWith("button", ROW)
      assert.ok(row, "the row is a control: the value is what opens the edit")
      const words = (row.textContent ?? "").trim()
      assert.match(words, new RegExp(`${ROW}\\s*${PURPOSE}\\s*${VALUE}`), "title, purpose, value")

      const shownValue = [...row.querySelectorAll("span")].find(
        (span) => span.textContent === VALUE,
      )
      assert.ok(shownValue, "the value is its own line")
      assert.match(
        shownValue.className,
        /text-primary/,
        "in the accent colour, so a value reads as one at a glance",
      )
      assert.ok(
        !row.querySelector("svg"),
        "and no chevron: the value and the press state are what mark the row tappable",
      )

      const empty = findAll("[data-setting]").find(
        (one) => one.getAttribute("data-setting") === "image",
      )
      assert.ok(empty, "a setting holding nothing still draws its row")
      assert.match(empty.textContent ?? "", /Not set/, "saying so, rather than showing a blank")
      const muted = [...empty.querySelectorAll("span")].find(
        (span) => span.textContent === "Not set",
      )
      assert.match(muted?.className ?? "", /text-muted-foreground/, "muted, not in the accent")

      await click(row)
      assert.equal(taps.length, 1, "a tap on the row asks for its edit")
    },
  )
})

const saved: string[] = []
let cancelled = 0

test("an edit holds the value and writes nothing until Save", async () => {
  saved.length = 0
  cancelled = 0
  await mount(
    <EditForm
      label="Name"
      value="Hermes"
      onSave={(next) => saved.push(next)}
      onCancel={() => (cancelled += 1)}
    />,
    async () => {
      const field = find("input")
      assert.ok(field, "the edit is a labelled field, the one place a text box belongs")
      assert.equal((field as HTMLInputElement).value, "Hermes", "holding the value the row showed")
      assert.equal(find("label")?.textContent, "Name", "labelled with the setting's own name")

      const save = named("button", "Save")
      assert.equal(save?.hasAttribute("disabled"), true, "nothing to save yet")
      assert.deepEqual(saved, [], "and nothing was written on opening")

      await typing(field, "Athena")
      assert.equal(save?.hasAttribute("disabled"), false, "a changed value can be saved")
      await click(save)
      assert.deepEqual(saved, ["Athena"], "Save hands the value to the caller once")

      await click(named("button", "Cancel"))
      assert.equal(cancelled, 1, "Cancel closes without saving")
      assert.deepEqual(saved, ["Athena"], "and writes nothing at all")
    },
  )
})

test("a secret edit masks its value behind a show toggle", async () => {
  await mount(
    <EditForm
      label="Server key"
      value="sk-live-123"
      kind="secret"
      onSave={() => {}}
      onCancel={() => {}}
    />,
    async () => {
      const field = find("input") as HTMLInputElement
      assert.equal(field.type, "password", "masked until asked")
      await click(named("button", "Show key"))
      assert.equal(field.type, "text", "and shown once asked")
    },
  )
})

const picked: string[] = []

const FRUIT = ["apple", "apricot", "banana", "blackberry", "blueberry", "cherry", "date", "fig"]

const options = (label: string) => findAll(`[data-pick-list="${label}"] > button`)
/** The one option wearing the tick: the chosen one, marked without a radio's semantics. */
const ticked = () => options("Fruit").find((row) => row.querySelector("svg"))

test("a pick is a list of buttons, the chosen one ticked, searchable where it is long", async () => {
  picked.length = 0
  await mount(
    <PickList
      label="Fruit"
      options={FRUIT.map((name) => ({ id: name, label: name, detail: `${name} notes` }))}
      selected="cherry"
      onPick={(id) => picked.push(id)}
    />,
    async () => {
      assert.ok(find('[data-pick-list="Fruit"]'), "the list names the setting it fills")
      assert.equal(options("Fruit").length, FRUIT.length, "one row per thing to pick")
      assert.equal(ticked()?.textContent?.startsWith("cherry"), true, "the chosen one ticked")
      assert.match(ticked()?.textContent ?? "", /cherry notes/, "each row says what it is, muted")
      assert.equal(
        options("Fruit").filter((row) => row.querySelector("svg")).length,
        1,
        "and only the chosen one wears the tick",
      )

      const search = find('input[aria-label="Search fruit"]')
      assert.ok(search, "a long list is searchable")
      await typing(search, "blue")
      const left = options("Fruit")
      assert.equal(left.length, 1, "the search narrows the list")
      assert.match(left[0].textContent ?? "", /blueberry/, "to what matches")

      await click(left[0])
      assert.deepEqual(picked, ["blueberry"], "and tapping a row picks it")
    },
  )
})

const shortPicked: string[] = []

test("a pick offers no search over a list too short to need one", async () => {
  shortPicked.length = 0
  await mount(
    <PickList
      label="Fruit"
      searchable={false}
      options={FRUIT.slice(0, 3).map((name) => ({ id: name, label: name }))}
      onPick={(id) => shortPicked.push(id)}
    />,
    async () => {
      absent("input", "no search field")
      await click(options("Fruit")[2])
      assert.deepEqual(shortPicked, ["banana"], "and the rows still pick")
    },
  )
})

const pickShape = () => find("[data-popup-form]")?.getAttribute("data-popup-form")

const aPick = (
  <PickSurface open onOpenChange={() => {}} title="Image">
    <PickList
      label="Image"
      searchable={false}
      options={[{ id: "gots", label: "Gots" }]}
      onPick={() => {}}
    />
  </PickSurface>
)

test(
  "a pick rises from the bottom as a sheet on a phone and a tablet",
  atWidth(768, async () => {
    await mount(aPick, async () => {
      assert.equal(pickShape(), "sheet", "a tablet still takes the sheet the phone has")
    })
  }),
)

test(
  "a pick is a drawer beside the screen from a laptop",
  laptop(async () => {
    await mount(aPick, async () => {
      assert.equal(pickShape(), "drawer", "at a laptop's width the list arrives in its own column")
    })
  }),
)

test("a pick surface says what it is picking and holds the list", async () => {
  await mount(
    <PickSurface open onOpenChange={() => {}} title="Image">
      <PickList
        label="Image"
        searchable={false}
        options={[{ id: "gots", label: "Gots" }]}
        onPick={() => {}}
      />
    </PickSurface>,
    async () => {
      assert.match(text(), /Image/, "the surface carries the setting's name")
      assert.ok(find('[data-pick-list="Image"]'), "with the list inside it")
    },
  )
})
