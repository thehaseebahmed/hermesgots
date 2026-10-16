/**
 * What a push can be about, and which of it a device wants. A push has a kind (`plugin/push.py`
 * and `netlify/lib/fcm.ts` keep the same lists), and the plugin puts it in a category: the kind
 * within the feature it belongs to (a session's kinds are Code's when it is a project session, else
 * Chats'; a research mission's are Research's). The user switches categories, alone or a whole feature at once, and each is an Android
 * notification channel of its own, so Android's settings can turn it off too.
 */

export type PushFeature = "chats" | "code" | "routines" | "research"

export type PushCategory =
  | "chat_input"
  | "chat_run_failed"
  | "chat_run_done"
  | "code_input"
  | "code_run_failed"
  | "code_run_done"
  | "code_pr_checks"
  | "code_pr_merged"
  | "code_setup_failed"
  | "routine_failed"
  | "research_input"
  | "research_done"
  | "research_failed"

export interface PushCategoryInfo {
  id: PushCategory
  feature: PushFeature
  title: string
  /** On until the user turns it off; the quieter ones start off. */
  on: boolean
  /** Android's importance for its channel: 4 makes a sound and peeks, 3 makes a sound, 2 is silent. */
  importance: 2 | 3 | 4
}

export const PUSH_FEATURES: { id: PushFeature; title: string }[] = [
  { id: "chats", title: "Chats" },
  { id: "code", title: "Code" },
  { id: "routines", title: "Routines" },
  { id: "research", title: "Research" },
]

export const PUSH_CATEGORIES: PushCategoryInfo[] = [
  {
    id: "chat_input",
    feature: "chats",
    title: "Questions and approvals",
    on: true,
    importance: 4,
  },
  { id: "chat_run_failed", feature: "chats", title: "Run failed", on: true, importance: 4 },
  { id: "chat_run_done", feature: "chats", title: "Run finished", on: false, importance: 3 },
  {
    id: "code_input",
    feature: "code",
    title: "Questions, approvals, plans",
    on: true,
    importance: 4,
  },
  { id: "code_run_failed", feature: "code", title: "Run failed", on: true, importance: 4 },
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
    title: "Brief and scope to review",
    on: true,
    importance: 4,
  },
  { id: "research_done", feature: "research", title: "Mission ready", on: true, importance: 3 },
  { id: "research_failed", feature: "research", title: "Mission failed", on: true, importance: 3 },
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
  if (typeof kind === "string" && kind.startsWith("research_"))
    return typeof id === "string" && id ? `/research/${encodeURIComponent(id)}` : "/research"
  return typeof id === "string" && id ? `/s/${encodeURIComponent(id)}` : null
}
