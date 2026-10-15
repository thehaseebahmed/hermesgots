import { cn } from "@/lib/utils"

/** A pulsing placeholder that holds an element's place while what goes in it loads. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn("animate-pulse rounded-xl bg-muted motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

export { Skeleton }
