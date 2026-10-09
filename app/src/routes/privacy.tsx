import { ArrowLeftIcon } from "lucide-react"
import { useNavigate } from "react-router"

import { PrivacyPolicy } from "@/components/privacy"
import { Button } from "@/components/ui/button"

/** `/privacy` on its own, outside sign-in, so it can be linked from anywhere. */
export function PrivacyPage() {
  const navigate = useNavigate()
  // Opened from a link in the app there's a page to go back to; opened directly, home is it.
  const back = () =>
    window.history.state?.idx > 0 ? navigate(-1) : navigate("/", { replace: true })
  return (
    <div className="flex h-dvh flex-col overflow-y-auto bg-background">
      <header className="sticky top-0 z-10 bg-background/80 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
        <div className="mx-auto flex min-h-11 max-w-2xl items-center gap-3">
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full"
            onClick={back}
            aria-label="Back"
          >
            <ArrowLeftIcon />
          </Button>
          <h1 className="text-xl font-semibold tracking-tight">Privacy</h1>
        </div>
      </header>
      <div className="mx-auto w-full max-w-2xl px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <PrivacyPolicy />
      </div>
    </div>
  )
}
