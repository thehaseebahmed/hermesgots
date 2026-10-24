/**
 * What a push can be about, and which of it a device wants. A push has a kind (`plugin/push.py`
 * and `netlify/lib/fcm.ts` keep the same lists), and the plugin puts it in a category: the kind
 * within the feature it belongs to (a session's kinds are Code's when it is a project session, else
 * Chats'; a research mission's are Research's). The user switches categories, alone or a whole feature at once, and each is an Android
 * notification channel of its own, so Android's settings can turn it off too.
 */

export type PushFeature = "chats" | "code" | "routines" | "research" | "meetings"

export type PushCategory =
  | "chat_input"
  | "chat_run_failed"
  | "chat_run_done"
  | "code_input"
  | "code_run_failed"
  | "code_run_done"
  | "code_pr_checks"
  | "code_pr_merged"
  | "code_afk_pr"
  | "code_setup_failed"
  | "routine_failed"
  | "research_input"
  | "research_done"
  | "research_failed"
  | "meeting_done"
  | "meeting_failed"

export interface PushCategoryInfo {
  id: PushCategory
  feature: PushFeature
  title: string
  /** On until the user turns it off; the quieter ones start off. */
  on: boolean
  /**
   * Android's importance for its channel: 4 makes a sound and peeks, 3 makes a sound, 2 is silent.
   * Only what waits on the user may peek; a failure or a completion must not take over the screen.
   */
  importance: 2 | 3 | 4
}

export const PUSH_FEATURES: { id: PushFeature; title: string }[] = [
  { id: "chats", title: "Chats" },
  { id: "code", title: "Code" },
  { id: "routines", title: "Routines" },
  { id: "research", title: "Research" },
  { id: "meetings", title: "Meetings" },
]

export const PUSH_CATEGORIES: PushCategoryInfo[] = [
  {
    id: "chat_input",
    feature: "chats",
    title: "Questions and approvals",
    on: true,
    importance: 4,
  },
  { id: "chat_run_failed", feature: "chats", title: "Run failed", on: true, importance: 3 },
  { id: "chat_run_done", feature: "chats", title: "Run finished", on: false, importance: 3 },
  {
    id: "code_input",
    feature: "code",
    title: "Questions, approvals, plans",
    on: true,
    importance: 4,
  },
  { id: "code_run_failed", feature: "code", title: "Run failed", on: true, importance: 3 },
  { id: "code_run_done", feature: "code", title: "Run finished", on: false, importance: 3 },
  {
    id: "code_pr_checks",
    feature: "code",
    title: "Pull request checks failing",
    on: true,
    importance: 3,
  },
  {
    id: "code_pr_merged",
    feature: "code",
    title: "Pull request merged",
    on: false,
    importance: 2,
  },
  {
    id: "code_afk_pr",
    feature: "code",
    title: "Pull request ready to review",
    on: true,
    importance: 3,
  },
  {
    id: "code_setup_failed",
    feature: "code",
    title: "Project setup failed",
    on: true,
    importance: 3,
  },
  { id: "routine_failed", feature: "routines", title: "Routine failed", on: true, importance: 3 },
  {
    id: "research_input",
    feature: "research",
    title: "Brief or scope to review",
    on: true,
    importance: 4,
  },
  { id: "research_done", feature: "research", title: "Mission ready", on: true, importance: 3 },
  { id: "research_failed", feature: "research", title: "Mission failed", on: true, importance: 3 },
  { id: "meeting_done", feature: "meetings", title: "Notes ready", on: true, importance: 3 },
  { id: "meeting_failed", feature: "meetings", title: "Notes failed", on: true, importance: 3 },
]

export type PushPrefs = Partial<Record<string, boolean>>

export function categoryOn(category: PushCategoryInfo, prefs: PushPrefs | undefined) {
  return prefs?.[category.id] ?? category.on
}

/** The categories of push this device wants: what the plugin and the registry filter on. */
export function wantedCategories(prefs: PushPrefs | undefined) {
  return PUSH_CATEGORIES.filter((category) => categoryOn(category, prefs)).map(
    (category) => category.id,
  )
}

/**
 * The categories this device can reach, and so the channels it gets: Meetings' two exist only once
 * that experiment is on, the other fourteen always.
 */
export function reachableCategories(meetings?: boolean) {
  return PUSH_CATEGORIES.filter((category) => category.feature !== "meetings" || Boolean(meetings))
}

/** The category's name in Android's notification settings, where the feature isn't a heading. */
export function channelName(category: PushCategoryInfo) {
  const feature = PUSH_FEATURES.find((f) => f.id === category.feature)?.title
  return feature && category.feature !== "routines"
    ? `${feature}: ${category.title}`
    : category.title
}

/** Where a tapped notification goes: the session it is about, or the screen of what failed. */
export function pushPath(kind: unknown, id: unknown) {
  if (kind === "routine_failed") return "/routines"
  if (kind === "clone_failed") return "/projects"
  if (typeof kind === "string" && kind.startsWith("meeting_"))
    return typeof id === "string" && id ? `/meetings/${encodeURIComponent(id)}` : "/meetings"
  if (typeof kind === "string" && kind.startsWith("research_"))
    return typeof id === "string" && id ? `/research/${encodeURIComponent(id)}` : "/research"
  return typeof id === "string" && id ? `/s/${encodeURIComponent(id)}` : null
}
