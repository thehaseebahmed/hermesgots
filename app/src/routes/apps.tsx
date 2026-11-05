import { lazy, Suspense, useCallback, useEffect, useState } from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { LayoutGridIcon, MenuIcon, PlusIcon, Undo2Icon } from "lucide-react"

import { attempt } from "@/lib/attempt"
import { BackButton } from "@/components/back-button"
import { AppBuildSheet } from "@/components/app-build-sheet"
import { useOpenDrawer } from "@/components/drawer-context"
import { ItemRow } from "@/components/item-list"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useAppPage, useApps } from "@/lib/apps"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"
import { itemToOpen, useAppsPane, useRememberOpened, type FeaturePane } from "@/lib/pane"

const HEADER =
  "sticky top-0 z-10 bg-background/80 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur"

const OpenUIBlock = lazy(() => import("@/components/openui/openui-block"))

/**
 * Apps: what the bot keeps, and the open app. Where the list stays beside the app (see
 * `useAppsPane`) this is the app pane: the one opened last, else the top one, else the empty list.
 */
export function AppsPage() {
  const pane = useAppsPane()
  const { apps, loaded } = useApps()
  if (!pane) return <AppsHome />
  if (!loaded) return null
  const first = itemToOpen(
    "apps",
    (apps ?? []).map((app) => app.id),
  )
  if (first) return <Navigate to={`/apps/${first}`} replace />
  return <AppsHome />
}

/** The list kept on screen beside the open app. */
export function AppsPane({ pane }: { pane: FeaturePane }) {
  return <AppsHome list={pane} />
}

function AppsHome({ list }: { list?: FeaturePane }) {
  const openDrawer = useOpenDrawer()
  const navigate = useNavigate()
  const { apps, error, loaded } = useApps()
  const [building, setBuilding] = useState(false)
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <AppBuildSheet open={building} onOpenChange={setBuilding} />
      <header className={HEADER}>
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full md:hidden"
            onClick={openDrawer}
            aria-label="Open conversations"
          >
            <MenuIcon />
          </Button>
          <h1 className="flex flex-1 items-center gap-2 text-xl font-semibold tracking-tight">
            Apps
          </h1>
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full"
            onClick={() => setBuilding(true)}
            aria-label="New app"
          >
            <PlusIcon />
          </Button>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {error && !apps && <p className="py-8 text-center text-sm text-warning">{error}</p>}
        {!loaded && !error && (
          <div className="flex justify-center py-8">
            <Spinner className="size-6" />
          </div>
        )}
        {apps && apps.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">No apps yet.</p>
        )}
        {apps && apps.length > 0 && (
          <ul aria-label="Apps" className="flex flex-col">
            {apps.map((app) => (
              <li key={app.id}>
                <ItemRow
                  icon={<LayoutGridIcon />}
                  title={app.title}
                  line={
                    <span className="truncate">
                      {app.pages.length === 1 ? "1 page" : `${app.pages.length} pages`}
                    </span>
                  }
                  selected={app.id === list?.selected}
                  onOpen={() => navigate(`/apps/${app.id}`, { replace: Boolean(list?.open) })}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * One app, open on its root page: the first page the host lists. The source is drawn by the same
 * block a reply's interface is, so a page that can't draw shows its source as code exactly as a
 * reply does.
 */
export function AppPage() {
  const { id = "" } = useParams()
  const { apps, loaded } = useApps()
  const { up } = useNav()
  const beside = Boolean(useAppsPane())
  const back = useCallback(() => up("/apps"), [up])
  useEffect(() => (beside ? undefined : setBackGuard(() => (back(), true))), [back, beside])
  const app = apps?.find((item) => item.id === id)
  useRememberOpened("apps", app?.id)
  const root = app?.pages[0]
  const { page, error, missing, undo } = useAppPage(id, root)
  const [undoing, setUndoing] = useState(false)

  if (!app)
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground">
        {loaded ? "This app is gone." : <Spinner className="size-6" />}
      </div>
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className={HEADER}>
        <div className="flex items-center gap-3">
          {!beside && <BackButton label="Back to Apps" onClick={back} />}
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight">
            {app.title}
          </h1>
          {page?.undoable && (
            <Button
              variant="outline"
              size="sm"
              disabled={undoing}
              onClick={async () => {
                setUndoing(true)
                await attempt("undo the change", undo)
                setUndoing(false)
              }}
            >
              <Undo2Icon /> Undo
            </Button>
          )}
        </div>
      </header>
      <div
        data-slot="app-page"
        className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))]"
      >
        {page ? (
          <Suspense fallback={null}>
            <OpenUIBlock source={page.source} open={false} streaming={false} draw="interface" />
          </Suspense>
        ) : error ? (
          <p className="py-8 text-center text-sm text-warning">
            {missing ? "This page is gone." : error}
          </p>
        ) : (
          <div className="flex justify-center py-8">
            <Spinner className="size-6" />
          </div>
        )}
      </div>
    </div>
  )
}
