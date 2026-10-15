// An image an agent returns holds its place with a skeleton while it loads — in a chat and in a
// project session — and gives way to the image, or to the tag's text when it can't load. A lone
// image takes the same cell as one in a group. The plugin media route is held back so the
// placeholder is on screen long enough to check, at phone and tablet widths, in light and dark.
import { app, assert, flow, pass } from "./lib.mjs"

const projectId = "p_1a2b3c4d"
const CELL = { 390: 96, 1024: 128 }

/** The images on screen: those painted, those still showing a skeleton, and the tags left as text. */
const shown = (page) =>
  page.evaluate(() => {
    const images = [...document.querySelectorAll("button img")].map(
      (img) => img.naturalWidth > 0 && getComputedStyle(img).visibility !== "hidden",
    )
    return {
      skeletons: document.querySelectorAll("[data-slot=skeleton]").length,
      painted: images.filter(Boolean).length,
      tags: [...document.querySelectorAll("code")].filter((code) =>
        code.textContent.startsWith("MEDIA:"),
      ).length,
    }
  })

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(
      `image-skeleton-${look}`,
      async ({ page, held, seed, send, shot, skeletons, stopSkeletons, until, watchSkeletons }) => {
        // Every image the plugin serves waits here, so the reply shows its placeholders first.
        const media = await held("**/api/plugins/memento/media**")

        for (const [what, chat] of [
          ["chat", { id: "img-chat", title: "Images" }],
          ["session", { id: "img-session", title: "Images", projectId }],
        ]) {
          media.hold()
          // A full page load each time, so a session reads its images as freshly as a chat does.
          await seed([chat])
          await page.goto(`${app}/c/${chat.id}`)
          await send("image please")
          // The reply's `MEDIA:<path>` tags: one image, a gallery of three, and one that isn't there.
          await until(
            async () => (await shown(page)).skeletons >= 5,
            20_000,
            "the image placeholders",
          )
          const boxes = await page.locator("[data-slot=skeleton]").evaluateAll((nodes) =>
            nodes.map((node) => {
              const box = node.getBoundingClientRect()
              return { w: Math.round(box.width), h: Math.round(box.height) }
            }),
          )
          assert.equal(
            new Set(boxes.map((box) => `${box.w}x${box.h}`)).size,
            1,
            `one image and a group reserve the same cell in a ${what}`,
          )
          assert.equal(boxes[0].h, CELL[width], `a cell is ${CELL[width]}px tall in a ${what}`)
          await shot(`loading-${what}`)
          // A placeholder that lives for one commit is missed by polling, so the page records every
          // one it renders while the images come in — including the one an image itself keeps inside
          // its own button while it decodes.
          await watchSkeletons()
          media.release()
          await until(async () => (await shown(page)).skeletons === 0, 20_000, "the images to load")
          const loaded = await shown(page)
          assert.equal(
            loaded.painted,
            4,
            `the four images the plugin serves are on screen in a ${what}`,
          )
          assert.equal(loaded.tags, 1, `the image that isn't there stays as its tag in a ${what}`)
          // The cell, not the image inside it: that carries the button's 1px border on every side.
          const cells = await page.evaluate(() =>
            [...document.querySelectorAll("button img")]
              .filter((img) => img.naturalWidth > 0)
              .map((img) => {
                const box = img.closest("button").getBoundingClientRect()
                return { w: Math.round(box.width), h: Math.round(box.height) }
              }),
          )
          assert.equal(
            new Set(cells.map((cell) => `${cell.w}x${cell.h}`)).size,
            1,
            `a lone image and a group's images are the same size in a ${what}`,
          )
          assert.equal(cells[0].h, CELL[width], `an image is ${CELL[width]}px tall in a ${what}`)
          const placeholders = await skeletons()
          await stopSkeletons()
          assert.ok(
            placeholders.some((one) => one.inButton && one.height >= CELL[width] - 2),
            `an image kept its own place while it decoded in a ${what}`,
          )
          await shot(`loaded-${what}`)
        }
        pass(`reply images hold their place and load at ${look}`)
      },
      { viewport: { width, height: width < 768 ? 844 : 768 }, dark },
    )
  }
}
