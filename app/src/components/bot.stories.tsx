/**
 * The characters: every bot's profile drawn whole — its picture still and moving, who it is, what it
 * says — and, for a posed one, every mood it can feel with the poof between them. This is where the
 * gallery lives now that the app has no Bots screen; a character's longer profile is kept in the
 * gots-universe repository.
 */
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"

import { Bot } from "@/components/bot"
import { BOT_MOODS, BOTS, botImage, type BotDefinition, type BotMood } from "@/components/bots"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

const meta = { title: "Characters", parameters: { layout: "fullscreen" } } satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  )
}

function CharacterProfile({ bot }: { bot: BotDefinition }) {
  const [mood, setMood] = useState<BotMood>("happy")
  return (
    <Card className="rounded-3xl">
      <CardContent className="flex flex-col gap-5">
        <div className="flex items-center gap-4">
          <Bot id={bot.id} animate mood={mood} className="size-28" />
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight">{bot.name}</h2>
              <Badge variant="secondary">{bot.posed ? "Posed" : "Still"}</Badge>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Bot id={bot.id} className="size-5" />
              <Bot id={bot.id} className="size-8" />
              <Bot id={bot.id} className="size-11" />
              <code>{botImage(bot)}</code>
            </div>
          </div>
        </div>

        <Section title="How it looks and moves">
          <p className="text-sm">{bot.description}</p>
        </Section>
        <Section title="Who it is">
          <p className="text-sm">{bot.character}</p>
        </Section>
        <Section title="What it says on an empty chat">
          <ol className="list-decimal pl-5 text-sm">
            {bot.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </Section>

        {bot.posed && (
          <Section title="Moods">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {BOT_MOODS.map((one) => (
                <Button
                  key={one.id}
                  variant={mood === one.id ? "default" : "outline"}
                  className="h-auto justify-start gap-2 rounded-2xl p-2 text-left"
                  aria-pressed={mood === one.id}
                  onClick={() => setMood(one.id)}
                >
                  <img src={botImage(bot, one.id)} alt="" className="size-10 shrink-0" />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-semibold">{one.name}</span>
                    <span className="text-xs font-normal whitespace-normal opacity-70">
                      {one.when}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
          </Section>
        )}
      </CardContent>
    </Card>
  )
}

/** Every character, each with its whole profile. */
export const Gallery: Story = {
  render: () => (
    <div className="mx-auto grid w-full max-w-5xl gap-4 p-4 lg:grid-cols-2">
      {BOTS.map((bot) => (
        <CharacterProfile key={bot.id} bot={bot} />
      ))}
    </div>
  ),
}

/** Crumb's profile alone. */
export const Crumb: Story = {
  render: () => (
    <div className="mx-auto w-full max-w-xl p-4">
      <CharacterProfile bot={BOTS.find((bot) => bot.id === "crumb")!} />
    </div>
  ),
}

/** Crumb as the app draws it: change the mood in the controls to watch the poof. */
export const CrumbMood: StoryObj<{ mood: BotMood }> = {
  args: { mood: "happy" },
  argTypes: { mood: { control: "select", options: BOT_MOODS.map((one) => one.id) } },
  render: ({ mood }) => (
    <div className="flex justify-center p-10">
      <Bot id="crumb" animate mood={mood} className="size-64" />
    </div>
  ),
}
