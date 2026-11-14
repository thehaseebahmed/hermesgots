/**
 * DESIGN.md's tokens as stories: each swatch is filled from the CSS variable the app itself uses, so
 * the page follows the Mode toolbar, and the label is what the file declares.
 */
import type { Meta, StoryObj } from "@storybook/react-vite"

import { parseDesign } from "@/lib/design-spec"
import designSource from "../../../DESIGN.md?raw"

const spec = parseDesign(designSource)

const meta = { title: "Foundations", parameters: { layout: "padded" } } satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const GROUPS: { title: string; match: (token: string) => boolean }[] = [
  {
    title: "Surfaces and ink",
    match: (token) =>
      /^(background|foreground|card|popover|muted|accent|secondary)(-foreground)?$/.test(token),
  },
  { title: "Action", match: (token) => /^primary(-foreground)?$/.test(token) },
  { title: "Hairlines", match: (token) => ["border", "input", "ring"].includes(token) },
  {
    title: "Tones",
    match: (token) => /^(warning|destructive|success|info|merged)(-ink)?$/.test(token),
  },
  { title: "Usage", match: (token) => token.startsWith("usage-") },
  { title: "Syntax", match: (token) => token.startsWith("syntax-") },
  { title: "Chart series", match: (token) => token.startsWith("chart-") },
]

export const Colors: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      {GROUPS.map((group) => {
        const tokens = Object.keys(spec.colors).filter(group.match)
        return (
          <section key={group.title} className="flex flex-col gap-2">
            <h3 className="text-sm text-muted-foreground">{group.title}</h3>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {tokens.map((token) => (
                <li
                  key={token}
                  className="flex items-center gap-3 rounded-2xl bg-card p-2 ring-1 ring-foreground/10"
                >
                  <span
                    aria-hidden
                    className="size-10 shrink-0 rounded-xl ring-1 ring-foreground/10"
                    style={{ backgroundColor: `var(--${token})` }}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">{token}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {spec.colors[token]}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  ),
}

export const Typography: Story = {
  render: () => (
    <ul className="flex max-w-2xl flex-col divide-y divide-border rounded-3xl bg-card ring-1 ring-foreground/10">
      {Object.entries(spec.typography).map(([name, token]) => (
        <li key={name} className="flex flex-col gap-1 px-5 py-4">
          <span
            className="truncate"
            style={{
              fontFamily: `"${token.fontFamily}", ui-sans-serif, system-ui, sans-serif`,
              fontSize: token.fontSize,
              fontWeight: Number(token.fontWeight),
              lineHeight: token.lineHeight,
              letterSpacing: token.letterSpacing,
            }}
          >
            Hermes bots that got your back
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {name} · {token.fontFamily.replace(" Variable", "")} {token.fontSize} /{" "}
            {token.fontWeight} / {token.lineHeight}
          </span>
        </li>
      ))}
    </ul>
  ),
}

export const Radii: Story = {
  render: () => (
    <ul className="grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
      {Object.entries(spec.rounded).map(([name, radius]) => (
        <li key={name} className="flex flex-col items-start gap-2">
          <span
            aria-hidden
            className="h-16 w-full border border-border bg-muted"
            style={{ borderRadius: radius }}
          />
          <span className="text-sm font-medium">{name}</span>
          <span className="font-mono text-xs text-muted-foreground">{radius}</span>
        </li>
      ))}
    </ul>
  ),
}

export const Measures: Story = {
  render: () => (
    <ul className="flex max-w-2xl flex-col gap-2">
      {Object.entries(spec.spacing).map(([name, size]) => (
        <li key={name} className="flex items-center gap-3">
          <span className="w-24 shrink-0 text-sm font-medium">{name}</span>
          <span className="min-w-0 flex-1">
            <span
              aria-hidden
              className="block h-3 max-w-full rounded-full bg-primary/70"
              style={{ width: size }}
            />
          </span>
          <span className="w-16 shrink-0 text-right font-mono text-xs text-muted-foreground">
            {size}
          </span>
        </li>
      ))}
    </ul>
  ),
}
