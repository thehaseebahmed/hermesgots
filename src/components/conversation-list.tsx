import { useLiveQuery } from "dexie-react-hooks"
import { NavLink, useNavigate } from "react-router"
import { PlusIcon, SettingsIcon } from "lucide-react"

import { Bot } from "@/components/bot"
import { Button } from "@/components/ui/button"
import { db } from "@/lib/db"
import { cn } from "@/lib/utils"

function relativeDay(timestamp: number) {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000)
  if (days <= 0)
    return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  if (days === 1) return "Yesterday"
  if (days < 7) return new Date(timestamp).toLocaleDateString([], { weekday: "short" })
  return new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" })
}

export function ConversationList({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate()
  const conversations = useLiveQuery(
    () => db.conversations.orderBy("updatedAt").reverse().toArray(),
    [],
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-3">
        <Bot className="size-8" />
        <span className="flex-1 text-lg font-semibold tracking-tight">Memento</span>
        <Button
          variant="outline"
          size="icon"
          className="rounded-full"
          aria-label="New chat"
          onClick={() => {
            navigate("/")
            onNavigate?.()
          }}
        >
          <PlusIcon />
        </Button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Conversations">
        {conversations?.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No chats yet. Say hi to Hermes!
          </p>
        )}
        <ul className="flex flex-col gap-0.5">
          {conversations?.map((conversation) => (
            <li key={conversation.id}>
              <NavLink
                to={`/c/${conversation.id}`}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    "flex min-h-11 items-center gap-3 rounded-2xl px-3 py-2 text-sm transition-colors hover:bg-muted",
                    isActive && "bg-muted font-medium",
                  )
                }
              >
                <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {relativeDay(conversation.updatedAt)}
                </span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <NavLink
          to="/settings"
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "flex min-h-11 items-center gap-3 rounded-2xl px-3 text-sm transition-colors hover:bg-muted",
              isActive && "bg-muted font-medium",
            )
          }
        >
          <SettingsIcon className="size-4 text-muted-foreground" />
          Settings
        </NavLink>
      </div>
    </div>
  )
}
