import { useState, type ReactNode } from "react"
import { CircleAlertIcon, InfoIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react"

import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const TONES = {
  info: { Icon: InfoIcon, className: "bg-muted/60 *:[svg]:text-muted-foreground" },
  warning: { Icon: TriangleAlertIcon, className: "bg-warning/10 *:[svg]:text-warning" },
  error: { Icon: CircleAlertIcon, className: "bg-destructive/10 *:[svg]:text-destructive" },
}

/** What the retry is called: it draws no label, so these words are all a reader has of it. */
const TRY_AGAIN = "Try again"

/**
 * The notice's own control: one tap asks the read again, and no second tap lands while that read is
 * out — every reload answers with a promise, which settles when its read lands or the effect behind
 * it is torn down, so the guard can never leave the button dead.
 */
export function Retry({ onRetry }: { onRetry: () => Promise<void> }) {
  const [retrying, setRetrying] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-lg"
      className="size-11 rounded-full"
      aria-label={TRY_AGAIN}
      title={TRY_AGAIN}
      disabled={retrying}
      onClick={() => {
        setRetrying(true)
        void Promise.resolve(onRetry()).finally(() => setRetrying(false))
      }}
    >
      <RotateCwIcon />
    </Button>
  )
}

/** A short notice at the top of a screen or sheet, above what it's about. */
export function Banner({
  tone = "warning",
  className,
  action,
  icon = true,
  children,
}: {
  tone?: keyof typeof TONES
  className?: string
  /** A control at the end, such as a dismiss, or the `Retry` a failed read hands its own reload. */
  action?: ReactNode
  /** False for a notice whose colour and words already say what it is, and whose room is tight. */
  icon?: boolean
  children: ReactNode
}) {
  const { Icon, className: toneClass } = TONES[tone]
  return (
    <Alert className={cn("rounded-2xl border-0 px-4 py-3", toneClass, className)}>
      {icon && <Icon aria-hidden />}
      <AlertDescription className="text-foreground">{children}</AlertDescription>
      {action && <AlertAction className="top-1/2 right-1 -translate-y-1/2">{action}</AlertAction>}
    </Alert>
  )
}
