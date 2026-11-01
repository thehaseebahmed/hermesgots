import type { ReactNode } from "react"
import { CircleAlertIcon, InfoIcon, TriangleAlertIcon } from "lucide-react"

import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert"
import { cn } from "@/lib/utils"

const TONES = {
  info: { Icon: InfoIcon, className: "bg-muted/60 *:[svg]:text-muted-foreground" },
  warning: { Icon: TriangleAlertIcon, className: "bg-warning/10 *:[svg]:text-warning" },
  error: { Icon: CircleAlertIcon, className: "bg-destructive/10 *:[svg]:text-destructive" },
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
  /** A button at the end, such as a dismiss. */
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
