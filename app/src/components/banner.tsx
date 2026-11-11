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
 * out — a reload that answers with its promise is what says when the read is over, and one that
 * answers with nothing is over at once.
 */
function Retry({ onRetry }: { onRetry: () => void | Promise<void> }) {
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
        void (async () => {
          try {
            await onRetry()
          } catch {
            // The read reports its own failure, in the sentence this control stands beside.
          } finally {
            setRetrying(false)
          }
        })()
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
  onRetry,
  icon = true,
  children,
}: {
  tone?: keyof typeof TONES
  className?: string
  /** A button at the end, such as a dismiss. */
  action?: ReactNode
  /**
   * The read this notice offers to ask again, drawn in the action slot: one control at the end, so a
   * notice carrying its own `action` draws that instead.
   */
  onRetry?: () => void | Promise<void>
  /** False for a notice whose colour and words already say what it is, and whose room is tight. */
  icon?: boolean
  children: ReactNode
}) {
  const { Icon, className: toneClass } = TONES[tone]
  const control = action ?? (onRetry ? <Retry onRetry={onRetry} /> : null)
  return (
    <Alert className={cn("rounded-2xl border-0 px-4 py-3", toneClass, className)}>
      {icon && <Icon aria-hidden />}
      <AlertDescription className="text-foreground">{children}</AlertDescription>
      {control && <AlertAction className="top-1/2 right-1 -translate-y-1/2">{control}</AlertAction>}
    </Alert>
  )
}
