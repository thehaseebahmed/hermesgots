/**
 * A page in the Previewer: its text is read and drawn in an opaque-origin frame whose head starts
 * with the sandbox policy, and a read that fails keeps Retry and the platform hand-over.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { Previewer, type PreviewItem } from "@/components/chat/previewer"
import { SANDBOX_CSP } from "@/lib/sandboxed-document"

import { click, findText, labelled, mount, spyOpen, until } from "./component-kit.tsx"

const SIGNED = "https://host.test/plugins/gots/media?path=%2Fh%2Freport.html&token=t"

const page = (patch: Partial<PreviewItem> = {}): PreviewItem => ({
  key: "/h/report.html",
  name: "report.html",
  type: "text/html",
  kind: "page",
  src: SIGNED,
  state: "ready",
  ...patch,
})

const photo: PreviewItem = {
  key: "/h/cat.png",
  name: "cat.png",
  type: "image/png",
  kind: "image",
  src: "https://host.test/cat.png",
  state: "ready",
}

const frame = () => document.querySelector<HTMLIFrameElement>('[role="dialog"] iframe')

/** A host that serves the page's text, or fails it the first `failures` times it is asked. */
function serve(html: string, failures = 0) {
  const asked: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input))
    if (asked.length <= failures) return new Response("gone", { status: 500 })
    return new Response(html, { headers: { "content-type": "text/html" } })
  }) as typeof fetch
  return asked
}

test("a page in a reply opens in the Previewer as a sandboxed frame", async () => {
  const asked = serve("<html><head><title>R</title></head><body><script>1</script></body></html>")
  let index: number | null = 0
  await mount(
    <Previewer
      request={{ items: [photo, page()], index: 1 }}
      open
      onIndex={(at) => (index = at)}
    />,
    async () => {
      await until(async () => frame() !== null, "the page's frame")
      const drawn = frame()!
      assert.equal(drawn.getAttribute("sandbox"), "allow-scripts")
      const doc = drawn.getAttribute("srcdoc") ?? ""
      assert.ok(
        doc.startsWith(
          `<html><head><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
        ),
        doc.slice(0, 200),
      )
      assert.ok(doc.includes("<script>1</script>"), "the page's own script is kept")
      assert.deepEqual(asked, [SIGNED])
      // Stepping still works with a frame on the stage.
      await click(labelled("button", "Previous"))
      assert.equal(index, 0)
    },
  )
})

test("a page that fails to read shows Retry and Open elsewhere", async () => {
  const asked = serve("<p>back</p>", 1)
  const retried: string[] = []
  const tabs = spyOpen()
  try {
    await mount(
      <Previewer
        request={{ items: [page()], index: 0, onRetry: (item) => retried.push(item.key) }}
        open
        onIndex={() => {}}
      />,
      async () => {
        await until(async () => findText("button", "Open elsewhere") !== null, "the hand-over")
        assert.equal(frame(), null)
        assert.ok(document.body.textContent?.includes("The host answered 500."))
        await click(findText("button", "Open elsewhere"))
        await until(async () => tabs.opened.length > 0, "the platform hand-over")
        assert.deepEqual(tabs.opened, [SIGNED])
        await click(findText("button", "Try again"))
        assert.deepEqual(retried, ["/h/report.html"])
        await until(async () => frame() !== null, "the page after Retry")
        assert.equal(asked.length, 2)
      },
    )
  } finally {
    tabs.restore()
  }
})
