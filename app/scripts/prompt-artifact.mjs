/**
 * Writing a rendered prompt section, once: the artifact's length printed with its headroom against
 * the gate, a render over the gate refused rather than written, and the delta against the checked-in
 * file named. Both generators use it (`build-openui-prompt.mjs` and `build-canvas-catalogue.mjs`),
 * because the host drops an over-cap section whole: the failure has to arrive at a build, never in a
 * bot's session.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * Writes `text` to `artifact`, or exits non-zero when it is over `max`. `label` names the section in
 * both lines; `advice` completes the refusal's sentence with what to cut instead.
 */
export function writePromptArtifact({ artifact, text, max, label, advice = "trim a rule" }) {
  if (text.length > max) {
    console.error(
      `${label}: ${text.length} characters, over the host's ${max}-character section limit by ` +
        `${text.length - max}. A section that size is dropped whole, so ${advice} rather than ` +
        `truncating.`,
    )
    process.exit(1)
  }
  let previous = null
  try {
    previous = readFileSync(artifact, "utf8").length
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  const grown = previous === null ? null : text.length - previous
  const delta = grown === null ? "first write" : `${grown >= 0 ? "+" : ""}${grown} characters`
  mkdirSync(dirname(artifact), { recursive: true })
  writeFileSync(artifact, text, "utf8")
  console.log(
    `${label}: wrote ${artifact} — ${text.length} characters, ` +
      `${max - text.length} headroom of ${max}, ${delta} against the checked-in artifact`,
  )
}
