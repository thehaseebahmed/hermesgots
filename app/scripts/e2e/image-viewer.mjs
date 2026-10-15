// A photo opened from a message holds its place while it decodes, and gives way to the photo itself.
// The page runs at a fifth of its normal speed so the placeholder is catchable at all.
import { app, assert, flow, pass } from "./lib.mjs"

for (const look of [
  { width: 390, dark: false },
  { width: 1024, dark: true },
]) {
  await flow(
    `image-viewer-${look.width}${look.dark ? "-dark" : ""}`,
    async ({ page, seed, shot, skeletons, stopSkeletons, until, watchSkeletons }) => {
      await seed([{ id: "photo-viewer", title: "Photo" }])
      await page.goto(`${app}/c/photo-viewer`)
      await page.evaluate(async () => {
        const { prepareAttachment } = await import("/src/lib/attachments.ts")
        const { sendMessage } = await import("/src/lib/chat.ts")
        // 1600px, the app's own cap, so decoding it takes a moment.
        const canvas = Object.assign(document.createElement("canvas"), {
          width: 1600,
          height: 1200,
        })
        const context = canvas.getContext("2d")
        for (let y = 0; y < 1200; y += 40)
          for (let x = 0; x < 1600; x += 40) {
            context.fillStyle = `hsl(${(x * 3 + y) % 360} 70% 55%)`
            context.fillRect(x, y, 40, 40)
          }
        const blob = await new Promise((done) => canvas.toBlob(done, "image/png"))
        const photo = await prepareAttachment(new File([blob], "photo.png", { type: "image/png" }))
        void sendMessage("photo-viewer", "a photo", { attachments: [photo] })
      })

      const tile = page.getByRole("button", { name: "Open photo.png" })
      await tile.waitFor({ timeout: 20_000 })
      // A placeholder that exists for one commit is missed by polling, so the page itself records
      // every one it ever renders, with the height it reserved.
      await watchSkeletons()
      // Slower than any phone, so the placeholder's own moment is on screen long enough to see.
      const cdp = await page.context().newCDPSession(page)
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 20 })
      await tile.click()
      await page.waitForTimeout(500)
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })

      await until(
        async () => (await page.locator("[data-slot=skeleton]").count()) === 0,
        20_000,
        "the photo to paint",
      )
      const big = await page.evaluate(
        () =>
          [...document.querySelectorAll("img")].filter(
            (img) =>
              img.naturalWidth > 0 &&
              getComputedStyle(img).visibility !== "hidden" &&
              img.getBoundingClientRect().width > 200,
          ).length,
      )
      assert.equal(big, 1, "the photo itself is on screen at full size")
      const placeholders = await skeletons()
      await stopSkeletons()
      assert.ok(
        placeholders.some((one) => one.height > 200),
        `the photo held its place while it decoded (placeholders: ${placeholders.map((one) => one.height).join(",")})`,
      )
      await shot("viewer")
      pass(
        `the viewer held a ${Math.max(...placeholders.map((one) => one.height))}px placeholder at ${look.width}${look.dark ? " dark" : ""}`,
      )
    },
    { viewport: { width: look.width, height: look.width < 768 ? 844 : 768 }, dark: look.dark },
  )
}
