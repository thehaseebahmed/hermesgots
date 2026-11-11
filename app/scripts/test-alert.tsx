/**
 * The alert's icon, over the text it sits beside: the icon spans the text's rows in a column of its
 * own and centres itself in them, with no rule nudging it — a nudge tuned for one line is wrong for
 * four. The length of the description is the one variable a DOM can change, so the contract is read
 * twice, over a description short enough to fit one line and one long enough to wrap; what those two
 * rules produce as geometry is measured in the browser (`scripts/e2e/bot-settings.mjs`), since a DOM
 * without layout cannot measure it (ADR 0019).
 */
import assert from "node:assert/strict"
import test from "node:test"
import { TriangleAlertIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { find, findAll, mount } from "./component-kit.tsx"

/** A description a phone's column holds on one line, and one it cannot. */
const ONE_LINE = "This bot's plugin is out of date."
const WRAPPED =
  "This bot's plugin is out of date! Update it to 0.2.0 or newer, then reopen this page so the bot's host can answer with what it runs now."

/** The alert's rule for its icon, as the primitive writes it on its own root: cva's `*:[svg]:…`. */
const rule = (utility: string) => `*:[svg]:${utility}`

/** Every rule the alert's root carries, as class tokens. */
const rules = () => (find('[data-slot="alert"]')?.getAttribute("class") ?? "").split(/\s+/)

/** The contract, read over a description of `words`: the same rules whatever the text's length. */
const centresItsIcon = (words: string) => async () => {
  await mount(
    <Alert>
      <TriangleAlertIcon aria-hidden />
      <AlertDescription>{words}</AlertDescription>
    </Alert>,
    async () => {
      assert.ok(find('[data-slot="alert"]'), "the alert is drawn")
      assert.equal(
        findAll('[data-slot="alert"] > svg').length,
        1,
        "the alert draws its icon once, beside the text",
      )
      assert.ok(find('[data-slot="alert-description"]'), "the alert draws the description")
      assert.ok(rules().includes(rule("row-span-2")), "the icon spans the text's rows")
      assert.ok(
        rules().includes(rule("self-center")),
        "the icon centres itself in the rows it spans",
      )
      assert.ok(
        !rules().some((one) => one.startsWith(rule("translate-y-"))),
        "no rule nudges the icon off that centre",
      )
    },
  )
}

test(
  "an alert centres its icon on the text beside it, over a description of one line",
  centresItsIcon(ONE_LINE),
)
test(
  "an alert centres its icon on the text beside it, over a description that wraps",
  centresItsIcon(WRAPPED),
)
