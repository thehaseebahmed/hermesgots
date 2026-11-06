import { useContext, useEffect, useRef } from "react"
import { defineComponent, type ComponentRenderProps } from "@openuidev/react-lang"
import { ChevronRightIcon } from "lucide-react"
import { z } from "zod/v4"

import { Button } from "@/components/ui/button"
import { linkResolves, type AppPages } from "@/lib/app-pages"
import { noteFailure } from "@/lib/report"

import { AppPagesContext } from "./app-pages-context.ts"
import { signatureRule } from "./prose.ts"

/** The open app's pages as the screen provides them, or `null` where no screen is drawing. */
export function useAppPages(): AppPages | null {
  return useContext(AppPagesContext)
}

const linkProps = z.object({ label: z.string(), page: z.string() })

/** The link itself: a control wearing its label, live only where its page is one of the app's. */
function LinkControl({ props }: ComponentRenderProps<z.infer<typeof linkProps>>) {
  const app = useAppPages()
  const there = app !== null && linkResolves(app.pages, props.page)
  // The note claims a stale page, so it is spoken only where a screen really draws pages: without
  // one nothing went missing — the control just has nowhere to move to.
  const noted = useRef(false)
  useEffect(() => {
    if (noted.current || app === null || there) return
    noted.current = true
    noteFailure("openui link", new Error(`no page "${props.page}"`))
  }, [app, there, props.page])
  return (
    <Button
      type="button"
      variant="outline"
      className="w-full justify-between"
      disabled={!there}
      onClick={() => app?.open(props.page)}
    >
      {props.label}
      <ChevronRightIcon aria-hidden className="size-4" />
    </Button>
  )
}

export const Link = defineComponent({
  name: "Link",
  props: linkProps,
  description: signatureRule("Link") ?? "",
  component: LinkControl,
})
