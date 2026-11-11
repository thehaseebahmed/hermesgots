/**
 * The alert's icon, over the text it sits beside: the icon spans the text's rows in a column of its
 * own and centres itself in them, with no rule nudging it — a nudge tuned for one line is wrong for
 * four. The contract is the rules the primitive carries, and it is the same whatever the text's
 * length, which is a thing a DOM without layout cannot see: the geometry is measured in the browser
 * (`scripts/e2e/bot-settings.mjs`), over a banner long enough to wrap (ADR 0019).
 */
import assert from "node:assert/strict"
import test from "node:test"
import { TriangleAlertIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { find, findAll, mount } from "./component-kit.tsx"

/** The out-of-date banner's own sentence: the one the browser measures, long enough to wrap. */
const WRAPPED =
  "This bot's plugin is out of date! Update it to 0.2.0 or newer, then reopen this page so the bot's host can answer with what it runs now."

/** The alert's rule for its icon, as the primitive writes it on its own root: cva's `*:[svg]:…`. */
const rule = (utility: string) => `*:[svg]:${utility}`

const rules = () => (find('[data-slot="alert"]')?.getAttribute("class") ?? "").split(/\s+/)

test("an alert centres its icon on the text beside it", async () => {
  await mount(
    <Alert>
      <TriangleAlertIcon aria-hidden />
      <AlertDescription>{WRAPPED}</AlertDescription>
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
})
