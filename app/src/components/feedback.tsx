import { useEffect, useState, type MouseEvent } from "react"
import { Browser } from "@capacitor/browser"
import { BugIcon, LightbulbIcon, type LucideIcon } from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { listEnabledProfiles } from "@/lib/db"
import { getPluginVersion } from "@/lib/hermes"
import { isNative } from "@/lib/native"

const ISSUES = "https://github.com/thehaseebahmed/memento/issues/new"

type Kind = "bug" | "feature"

const KINDS: { kind: Kind; template: string; label: string; icon: LucideIcon }[] = [
  { kind: "bug", template: "bug_report.yml", label: "Report a bug", icon: BugIcon },
  {
    kind: "feature",
    template: "feature_request.yml",
    label: "Suggest a feature",
    icon: LightbulbIcon,
  },
]

/** Where the app runs, for a bug report's Device field. */
function device() {
  const where = isNative
    ? "Android app"
    : matchMedia("(display-mode: standalone)").matches
      ? "Installed web app"
      : "Browser"
  return `${where} · ${navigator.userAgent}`
}

/** The plugin versions on the bots that are turned on, without naming the bots or their hosts. */
async function pluginVersions() {
  const bots = (await listEnabledProfiles()).filter((bot) => bot.apiKey && bot.baseUrl.trim())
  const versions = await Promise.all(bots.map((bot) => getPluginVersion(bot)))
  const found = [...new Set(versions.filter((v): v is string => Boolean(v)))]
  const missing = versions.filter((v) => !v).length
  return [
    ...found,
    ...(missing ? [`${missing} ${missing === 1 ? "bot" : "bots"} didn't answer`] : []),
  ].join(", ")
}

/** A new GitHub issue from one of the repo's forms, its fields filled in by their ids. */
function issueUrl(template: string, fields: Record<string, string>) {
  const params = new URLSearchParams({ template })
  for (const [id, value] of Object.entries(fields)) if (value) params.set(id, value)
  return `${ISSUES}?${params}`
}

/** Settings' Send feedback: a bug report or a feature request on GitHub, versions filled in. */
export function FeedbackSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [plugins, setPlugins] = useState("")
  useEffect(() => {
    if (!open) return
    let current = true
    void pluginVersions().then((versions) => current && setPlugins(versions))
    return () => {
      current = false
    }
  }, [open])

  const urlFor = (kind: Kind, template: string) =>
    issueUrl(
      template,
      kind === "bug"
        ? { "app-version": __APP_VERSION__, "plugin-version": plugins, platform: device() }
        : { "app-version": __APP_VERSION__ },
    )

  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    onOpenChange(false)
    if (!isNative) return
    event.preventDefault()
    void Browser.open({ url: event.currentTarget.href })
  }

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader className="pb-2">
          <PopupTitle>Send feedback</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-1 px-4 pb-4 sm:px-6">
          {KINDS.map(({ kind, template, label, icon: Icon }) => (
            <a
              key={kind}
              href={urlFor(kind, template)}
              target="_blank"
              rel="noreferrer"
              onClick={follow}
              className="flex min-h-14 items-center gap-4 rounded-2xl px-4 text-base transition-colors hover:bg-muted"
            >
              <Icon className="size-5 shrink-0 text-muted-foreground" />
              {label}
            </a>
          ))}
        </div>
      </PopupContent>
    </Popup>
  )
}
