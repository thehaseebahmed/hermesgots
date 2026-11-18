import { useEffect, useMemo, useRef } from "react"
import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Banner } from "@/components/banner"
import type { ContextUsage } from "@/components/chat/usage-sheet"
import { summaryKeyOf, summaryRowsOfKey } from "@/lib/compaction-seam"
import { useWide } from "@/lib/media"
import { chosenOf } from "@/lib/model-pick"
import { useNow } from "@/lib/threads"
import { contextWindow } from "@/lib/context"
import { db, type Conversation, type ModelChoice, type Profile } from "@/lib/db"
import { botModel, fullModel, useModelInfo } from "@/lib/model-info"
import { syncContextWindow, useModelCatalog } from "@/lib/models"
import {
  effectiveProvider,
  limitNotice,
  limitNoticeKey,
  refreshProviderUsage,
  resetsInText,
} from "@/lib/provider-usage"
import { quietly } from "@/lib/report"

/**
 * What a chat's header and the box above its composer say about its context and its provider's
 * limits, for the model it runs next: the chat's own pick, the bot's default, else what the host
 * last reported. It also keeps both reads fresh: the model's window when the connection changes,
 * and the provider's limits when the chat opens and when its provider changes (the chat's other
 * follow-up reads do the rest).
 */
export function useChatUsage(
  chat: Conversation | undefined | null,
  profile: Profile | undefined | null,
  pick: ModelChoice | undefined,
) {
  const tracked = Boolean(profile?.apiKey && !profile.disabled)
  const live = chat?.liveContext
  const hostInfo = useModelInfo(profile)
  const catalog = useModelCatalog()
  const currentModel = pick ?? (profile ? botModel(profile, hostInfo) : undefined)
  const usage: ContextUsage = {
    tracked,
    tokens: tracked ? live?.tokens : undefined,
    // The window belongs to the model the next turn runs, not the one the last call did: a switch
    // shows at once, rather than after the new model's first call.
    window: contextWindow(live, profile ?? undefined, currentModel, catalog),
    model: currentModel ? fullModel(currentModel) : undefined,
  }
  const provider = effectiveProvider(chat ?? undefined, profile ?? undefined)
  const providerUsage =
    profile?.providerUsage && profile.providerUsage.provider === provider
      ? profile.providerUsage
      : undefined
  const notice = limitNotice(providerUsage)
  const noticeDismissed =
    Boolean(notice && provider) && profile?.limitDismissed === limitNoticeKey(provider!, notice!)

  // Picks up a model changed on the server (only when the connection does, not on every write);
  // the ring follows via the live query.
  const profileId = profile?.id
  const baseUrl = profile?.baseUrl
  const apiKey = profile?.apiKey
  useEffect(() => {
    if (!profileId) return
    void db.profiles.get(profileId).then((current) => current && syncContextWindow(current))
  }, [profileId, baseUrl, apiKey])
  useEffect(() => {
    if (!profileId) return
    void refreshProviderUsage(profileId, provider).catch(quietly("Reading provider limits"))
  }, [profileId, baseUrl, apiKey, provider])

  return { usage, provider, providerUsage, notice, noticeDismissed }
}

/**
 * What a chat's screen reads of its surface, in one place: the rows its thread keeps for the
 * compactions its record names, the context and provider-limit usage of the model it runs next, and
 * the value the composer's limit notice is handed. The usage sheet's open state stays each screen's
 * own — a chat's sheet is drawn by `ChatActions`, a canvas's beside its page — so the screen passes
 * the `onView` that opens it.
 */
export function useChatSurface(
  chat: Conversation | undefined | null,
  profile: Profile | undefined | null,
  onView: () => void,
) {
  // A live query hands back a fresh array on every run, so what the thread keeps is keyed on the ids
  // the record names rather than on the array that carried them.
  const summaryKey = summaryKeyOf(chat?.compactions)
  const summaries = useMemo(() => summaryRowsOfKey(summaryKey), [summaryKey])
  const { usage, providerUsage, notice, provider, noticeDismissed } = useChatUsage(
    chat,
    profile,
    chosenOf(chat?.modelChoice),
  )
  // The limit value keeps its identity while the notice does, since the composer is one component for
  // the chat's life: `onView` is read through a ref so a fresh closure doesn't rebuild it.
  const view = useRef(onView)
  useEffect(() => {
    view.current = onView
  }, [onView])
  const limit = useMemo(
    () => ({ usage: { notice, provider, noticeDismissed }, onView: () => view.current() }),
    [notice, provider, noticeDismissed],
  )
  return { summaries, usage, providerUsage, limit }
}

/**
 * The warning the composer carries above its text when the provider's account is out or nearly
 * (ADR 0007, its placement ADR 0077): a claim about the account, which a dismiss silences until it
 * becomes a different claim. Nothing when there is none or it was dismissed.
 *
 * It stands on the box's own top edge, inside its corner rather than above the box, and carries no
 * icon: the tone and the line itself say what it is, and the room is the composer's.
 */
export function LimitNotice({
  usage,
  profileId,
  onView,
}: {
  usage: Pick<ReturnType<typeof useChatUsage>, "notice" | "provider" | "noticeDismissed">
  profileId?: string
  onView: () => void
}) {
  const { notice, provider, noticeDismissed } = usage
  const wide = useWide()
  // The line counts down while the notice is up: an "in 3d 4h" that never moves is wrong by then.
  const now = useNow()
  if (!notice || !provider || noticeDismissed) return null
  const exhausted = notice.remaining <= 0
  // A phone's notice leaves out the window's name: "Approaching Limit" is enough to send the reader
  // to the sheet, which names every window.
  const text = exhausted
    ? wide
      ? `${notice.label} Limit Reached`
      : "Limit Reached"
    : wide
      ? `Approaching ${notice.label} Limit`
      : "Approaching Limit"
  return (
    <Banner
      tone={exhausted ? "error" : "warning"}
      // The tone is the only mark it has, so the line itself wears it.
      icon={false}
      // Inset from a shell whose corners are 28px, so the two radii stay concentric, and enough room
      // on the right for both controls. The width is the composer's to give rather than `Banner`'s
      // `w-full`: that 100% is measured on the shell's content box, and in the column the composer
      // draws (a centred one) a child that wide swallows its own horizontal margins — the notice
      // then sits flush against the shell while only its top gap survives. Stretching to the column
      // minus the margins is what makes the inset real, and lands its text on the placeholder's 20px.
      className="mx-2 mt-2 w-auto self-stretch rounded-[1.25rem] px-3 py-2.5 has-data-[slot=alert-action]:pr-32"
      action={
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" type="button" onClick={onView}>
            View usage
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            className="size-8 shrink-0"
            onClick={() =>
              profileId &&
              void db.profiles
                .update(profileId, { limitDismissed: limitNoticeKey(provider, notice) })
                .catch(() => undefined)
            }
            aria-label="Dismiss"
          >
            <XIcon />
          </Button>
        </div>
      }
    >
      <div className="flex flex-col">
        <span className={exhausted ? "text-destructive-ink" : "text-warning-ink"}>{text}</span>
        {notice.resetsAt && (
          <span className="text-muted-foreground tabular-nums">
            Resets in {resetsInText(notice.resetsAt, now)}
          </span>
        )}
      </div>
    </Banner>
  )
}
