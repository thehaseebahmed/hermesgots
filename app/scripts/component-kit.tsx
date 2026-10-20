/**
 * What the component tests stand on: the faked HTTP boundary's answer, the passes that let a
 * screen's reads land, the queries a test asks of the DOM, and the AFK pop-up on a phone's screen.
 * The suite is `node --test --import ./scripts/component-hooks.mjs`; this is the part of it no test
 * should spell twice.
 */
import assert from "node:assert/strict"
import { act } from "react"
import { createRoot } from "react-dom/client"

import { AfkPopup } from "@/components/afk"

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Waits for the reads a screen starts to land, then lets React commit what they changed. */
export async function settle() {
  for (let quiet = 0; quiet < 4; quiet += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
}

/**
 * The AFK pop-up open on a phone's screen, torn down after the test: a pop-up left mounted keeps
 * its polls running, and a run of the file would carry one test's timers into the next.
 */
export async function mountAfk(
  config: { baseUrl: string; apiKey?: string },
  projectId: string,
  body: () => Promise<void>,
) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(<AfkPopup open onOpenChange={() => {}} config={config} projectId={projectId} />),
    )
    await settle()
    await body()
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
}

export async function click(element: Element | null) {
  assert.ok(element, "the control is on screen")
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
  })
  await settle()
}

export async function type(element: Element | null, value: string) {
  assert.ok(element, "the field is on screen")
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    setter?.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await settle()
}

export const text = () => document.body.textContent ?? ""
export const find = (selector: string) => document.querySelector(selector)
export const findAll = (selector: string) => [...document.querySelectorAll(selector)]
export const findText = (selector: string, label: string) =>
  findAll(selector).find((one) => one.textContent?.includes(label)) ?? null
