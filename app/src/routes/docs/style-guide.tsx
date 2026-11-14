/**
 * The style guide, at `/docs/style-guide` behind Developer's switch: `DESIGN.md` read as data for
 * the tokens, its prose for the rules, and the app's own components drawn live for the shapes. Each
 * swatch reads the CSS variable the app itself uses, so the page follows the colour mode and a token
 * that drifts from the file shows as a mismatch rather than a stale picture.
 */
import { useMemo, useRef, useState, type ReactNode } from "react"
import {
  BellIcon,
  CircleCheckIcon,
  MessageSquareIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react"

import { Banner } from "@/components/banner"
import { Markdown } from "@/components/chat/markdown"
import { Chip } from "@/components/chip"
import { ConfirmDestructive } from "@/components/confirm-destructive"
import { DeveloperOnly } from "@/components/developer-only"
import { DocPage } from "@/components/doc-page"
import { ItemRow } from "@/components/item-list"
import { LabBadge } from "@/components/lab-badge"
import { PickGroup, PickRow } from "@/components/pick-row"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { SearchField } from "@/components/search-field"
import { Segmented } from "@/components/segmented"
import { Group, LinkRow, RowText, SwitchRow, rowClass } from "@/components/settings-chrome"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { parseDesign, sectionOf, type TokenMap } from "@/lib/design-spec"
import { REPLY_TEXT } from "@/lib/layout"
import { cn } from "@/lib/utils"
import designSource from "../../../../DESIGN.md?raw"

/** `{colors.primary}` reads as a code span in the thread's renderer, which has no braces to draw. */
const prose = (body: string) => body.replace(/\{([a-z0-9.-]+)\}/gi, "`$1`")

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      id={id}
      data-style-section={id}
      className="flex flex-col gap-4 border-t border-border pt-8 first:border-t-0 first:pt-0"
    >
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  )
}

function Rules({ body }: { body: string }) {
  if (!body) return null
  return <Markdown className={cn("text-muted-foreground", REPLY_TEXT)}>{prose(body)}</Markdown>
}

/** A live component and the module it comes from, on one muted plate. */
function Specimen({
  name,
  source,
  children,
}: {
  name: string
  source: string
  children: ReactNode
}) {
  return (
    <div data-specimen={name} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-base font-medium">{name}</h3>
        <code className="min-w-0 text-xs break-words text-muted-foreground">{source}</code>
      </div>
      <div className="flex flex-col gap-3 rounded-3xl bg-muted/60 p-4">{children}</div>
    </div>
  )
}

/** Where a colour token is drawn from: the app's variable of the same name. */
const COLOR_GROUPS: { title: string; match: (token: string) => boolean }[] = [
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

function Swatches({ colors }: { colors: TokenMap }) {
  return (
    <div className="flex flex-col gap-6">
      {COLOR_GROUPS.map((group) => {
        const tokens = Object.keys(colors).filter(group.match)
        if (!tokens.length) return null
        return (
          <div key={group.title} className="flex flex-col gap-2">
            <h3 className="text-sm text-muted-foreground">{group.title}</h3>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {tokens.map((token) => (
                <li
                  key={token}
                  data-color-token={token}
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
                      {colors[token]}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

function Typography({ spec }: { spec: ReturnType<typeof parseDesign> }) {
  return (
    <ul className="flex flex-col divide-y divide-border rounded-3xl bg-card ring-1 ring-foreground/10">
      {Object.entries(spec.typography).map(([name, token]) => (
        <li key={name} data-type-token={name} className="flex flex-col gap-1 px-5 py-4">
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
  )
}

function Shapes({ rounded }: { rounded: TokenMap }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {Object.entries(rounded).map(([name, radius]) => (
        <li key={name} data-radius-token={name} className="flex flex-col items-start gap-2">
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
  )
}

function Measures({ spacing }: { spacing: TokenMap }) {
  return (
    <ul className="flex flex-col gap-2">
      {Object.entries(spacing).map(([name, size]) => (
        <li key={name} data-spacing-token={name} className="flex items-center gap-3">
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
  )
}

function Components() {
  const [segment, setSegment] = useState("one")
  const [chip, setChip] = useState(true)
  const [on, setOn] = useState(true)
  const [pick, setPick] = useState("a")
  const [query, setQuery] = useState("")
  const [sheet, setSheet] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  return (
    <div className="flex flex-col gap-8">
      <Specimen name="Button" source="components/ui/button.tsx">
        <div className="flex flex-wrap gap-2">
          <Button size="lg">Primary</Button>
          <Button size="lg" variant="secondary">
            Secondary
          </Button>
          <Button size="lg" variant="outline">
            Outline
          </Button>
          <Button size="lg" variant="ghost">
            Ghost
          </Button>
          <Button size="lg" variant="destructive">
            <Trash2Icon data-icon="inline-start" />
            Destructive
          </Button>
          <Button size="lg" disabled>
            Disabled
          </Button>
        </div>
      </Specimen>

      <Specimen name="Badge and Labs" source="components/ui/badge.tsx, lab-badge.tsx">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Destructive</Badge>
          <LabBadge />
        </div>
      </Specimen>

      <Specimen name="Chip and Segmented" source="components/chip.tsx, segmented.tsx">
        <div className="flex flex-wrap gap-2">
          <Chip active={chip} onClick={() => setChip(true)}>
            Active
          </Chip>
          <Chip active={!chip} onClick={() => setChip(false)}>
            At rest
          </Chip>
        </div>
        <Segmented
          label="Style guide segments"
          value={segment}
          onChange={setSegment}
          options={[
            { id: "one", label: "One" },
            { id: "two", label: "Two" },
            { id: "three", label: "Three" },
          ]}
        />
      </Specimen>

      <Specimen name="Fields" source="components/ui/input.tsx, search-field.tsx">
        <div className="flex flex-col gap-2">
          <Label htmlFor="style-guide-name" className="text-muted-foreground">
            Name
          </Label>
          <Input id="style-guide-name" defaultValue="Hermes" className="h-12 rounded-full px-4" />
        </div>
        <SearchField value={query} onChange={setQuery} label="Search" />
      </Specimen>

      <Specimen name="Settings group" source="components/settings-chrome.tsx">
        <Group>
          <LinkRow
            to="/docs/style-guide"
            leading={<BellIcon className="size-5 shrink-0 text-muted-foreground" />}
            title="A row that goes somewhere"
            subtitle="Its muted line says what it holds"
          />
          <SwitchRow
            id="style-guide-switch"
            icon={SparklesIcon}
            title="A row with a switch"
            subtitle="The whole row toggles"
            checked={on}
            onCheckedChange={setOn}
          />
          <div className={rowClass}>
            <RowText title="A row that only reads" subtitle="Value in the accent colour" />
            <span className="text-sm text-primary">Online</span>
          </div>
        </Group>
      </Specimen>

      <Specimen name="Item row" source="components/item-list.tsx">
        <div className="flex flex-col">
          <ItemRow
            icon={<MessageSquareIcon />}
            tone="success"
            title="A chat that is up to date"
            when="2m"
            line="The newest line, cut to one"
          />
          <ItemRow
            icon={<MessageSquareIcon />}
            tone="warning"
            unread
            title="A chat waiting on you"
            when="1h"
            line="A question needs an answer"
            warn
          />
          <ItemRow
            icon={<CircleCheckIcon />}
            tone="muted"
            title="The open item"
            when="Mon"
            line="Selected rows take the accent plate"
            selected
          />
        </div>
      </Specimen>

      <Specimen name="Pick rows" source="components/pick-row.tsx">
        <PickGroup mode="choose" surface="plate" heading="Choose one" label="Style guide picks">
          {["a", "b"].map((id) => (
            <PickRow
              key={id}
              title={id === "a" ? "First choice" : "Second choice"}
              line="A pick is one control wherever a sheet offers a list"
              selected={pick === id}
              onPick={() => setPick(id)}
            />
          ))}
        </PickGroup>
      </Specimen>

      <Specimen name="Banner" source="components/banner.tsx">
        <Banner tone="info">Info says what is true.</Banner>
        <Banner tone="warning">A warning says what to watch.</Banner>
        <Banner tone="error">An error says what failed and what to try.</Banner>
      </Specimen>

      <Specimen name="Card" source="components/ui/card.tsx">
        <Card>
          <CardHeader>
            <CardTitle>A feature card</CardTitle>
            <CardDescription>One surface, one hairline, no shadow</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center gap-3">
            <Switch checked={on} onCheckedChange={setOn} aria-label="Card switch" />
            <span className="text-sm text-muted-foreground">{on ? "On" : "Off"}</span>
          </CardContent>
        </Card>
      </Specimen>

      <Specimen name="Loading" source="components/ui/spinner.tsx, skeleton.tsx">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Spinner />
          Loading keeps the shape it is about to fill
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </Specimen>

      <Specimen name="Pop-ups" source="components/popup.tsx, confirm-destructive.tsx">
        <div className="flex flex-wrap gap-2">
          <Button ref={anchor} variant="secondary" size="lg" onClick={() => setSheet(true)}>
            Open a pop-up
          </Button>
          <Button variant="destructive" size="lg" onClick={() => setConfirm(true)}>
            Ask to confirm
          </Button>
        </div>
        <Popup open={sheet} onOpenChange={setSheet}>
          <PopupContent>
            <PopupHeader>
              <PopupTitle>A sheet</PopupTitle>
            </PopupHeader>
            <p className="px-4 pb-6 text-sm text-muted-foreground">
              A bottom sheet below 1024px, a side drawer from it.
            </p>
          </PopupContent>
        </Popup>
        <ConfirmDestructive
          open={confirm}
          onOpenChange={setConfirm}
          title="Delete this?"
          description="A confirmation is a centred dialog on every screen."
          confirmLabel="Delete"
          onConfirm={async () => setConfirm(false)}
        />
      </Specimen>
    </div>
  )
}

export function StyleGuidePage() {
  const spec = useMemo(() => parseDesign(designSource), [])
  const rules = (title: string) => <Rules body={sectionOf(spec, title)} />
  return (
    <DeveloperOnly>
      <DocPage title="Style guide" backTo="/settings/developer" backLabel="Back to Developer">
        <div className="flex flex-col gap-10">
          <Section id="overview" title="Overview">
            {rules("Overview")}
          </Section>
          <Section id="colors" title="Colors">
            <Swatches colors={spec.colors} />
            {rules("Colors")}
          </Section>
          <Section id="typography" title="Typography">
            <Typography spec={spec} />
            {rules("Typography")}
          </Section>
          <Section id="layout" title="Layout">
            <Measures spacing={spec.spacing} />
            {rules("Layout")}
          </Section>
          <Section id="shapes" title="Shapes">
            <Shapes rounded={spec.rounded} />
            {rules("Shapes")}
          </Section>
          <Section id="elevation" title="Elevation & Depth">
            {rules("Elevation & Depth")}
          </Section>
          <Section id="components" title="Components">
            <Components />
            {rules("Components")}
          </Section>
          <Section id="rules" title="Do's and Don'ts">
            {rules("Do's and Don'ts")}
          </Section>
        </div>
      </DocPage>
    </DeveloperOnly>
  )
}
