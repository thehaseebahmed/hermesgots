import { Link } from "react-router"
import { ArrowLeftIcon } from "lucide-react"

import { Bot } from "@/components/bot"
import { BOTS, DEFAULT_BOT_ID } from "@/components/bots"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

/** Gallery of every bot, animated and still. Not linked from the UI yet. */
export function BotsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="mx-auto flex w-full max-w-4xl items-center gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
        <Button
          variant="outline"
          size="icon-lg"
          className="size-11 rounded-full"
          nativeButton={false}
          render={<Link to="/" aria-label="Back to chat" />}
        >
          <ArrowLeftIcon />
        </Button>
        <h1 className="text-xl font-semibold tracking-tight">Bots</h1>
      </header>
      <div className="mx-auto grid w-full max-w-4xl grid-cols-2 gap-3 px-4 pb-8 sm:grid-cols-3 lg:grid-cols-4">
        {BOTS.map((bot) => (
          <Card key={bot.id} className="rounded-3xl">
            <CardContent className="flex flex-col items-center gap-3 text-center">
              <Bot id={bot.id} animate className="size-24" />
              <div className="flex items-center gap-2">
                <Bot id={bot.id} className="size-7" />
                <span className="font-semibold">{bot.name}</span>
                {bot.id === DEFAULT_BOT_ID && <Badge>In use</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">{bot.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
