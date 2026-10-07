import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"

import { cn } from "@/lib/utils"

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex min-h-0 flex-col", className)}
      {...props}
    />
  )
}

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("flex w-full items-stretch border-b border-border", className)}
      {...props}
    />
  )
}

/** An underlined tab; the line sits under the label, as wide as the label. */
function TabsTrigger({ className, children, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "group flex min-h-12 flex-1 items-stretch justify-center text-sm font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50 data-active:text-foreground",
        className,
      )}
      {...props}
    >
      <span className="relative flex items-center px-1 after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:scale-x-0 after:rounded-full after:bg-foreground after:transition-transform after:duration-200 after:ease-out group-data-active:after:scale-x-100 motion-reduce:after:transition-none">
        {children}
      </span>
    </TabsPrimitive.Tab>
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn(
        "min-h-0 flex-1 outline-none",
        // Slides in from the side of the tab it was opened from; not on first render ("none"). The
        // panel it replaces goes at once, rather than overlapping it.
        "duration-250 ease-out data-ending-style:hidden motion-safe:data-[activation-direction=left]:animate-in motion-safe:data-[activation-direction=left]:fade-in-0 motion-safe:data-[activation-direction=left]:slide-in-from-left-6 motion-safe:data-[activation-direction=right]:animate-in motion-safe:data-[activation-direction=right]:fade-in-0 motion-safe:data-[activation-direction=right]:slide-in-from-right-6",
        className,
      )}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
