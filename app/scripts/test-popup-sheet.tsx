/**
 * A pop-up's heading, in the sheet form every phone gets: the header gives the heading room above it
 * rather than letting its box begin at the drag handle's bottom edge. Read as the class the shared
 * header carries, since a DOM without layout cannot measure the 16px — the browser pass in `e2e
 * canvas` measures the gap itself.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"

import { atWidth, find, mount, wordsOf } from "./component-kit.tsx"

/** A pop-up as a screen draws one: a heading and one row, in whichever form the width picks. */
const Sheet = () => (
  <Popup open>
    <PopupContent>
      <PopupHeader>
        <PopupTitle>Options</PopupTitle>
      </PopupHeader>
      <div className="px-4 pb-4">A row</div>
    </PopupContent>
  </Popup>
)

/** The open pop-up, its header and its heading. */
const popup = () => find("[data-popup-form]")
const header = () => find('[data-popup-form] [data-slot="sheet-header"]')
const heading = () => find('[data-popup-form] [data-slot="sheet-title"]')

test(
  "a sheet's header keeps 16px of room above its heading",
  atWidth(390, async () => {
    await mount(<Sheet />, async () => {
      assert.equal(popup()?.getAttribute("data-popup-form"), "sheet", "a phone draws the sheet form")
      assert.equal(wordsOf(heading()), "Options", "the sheet's heading is drawn")

      const classes = header()?.classList ?? []
      assert.ok(classes.contains("pt-4"), "the sheet's header pads its top by the house's step (16px)")
      assert.ok(
        !classes.contains("pt-0"),
        "and never takes the top padding away, which leaves the heading against the handle",
      )
    })
  }),
)
