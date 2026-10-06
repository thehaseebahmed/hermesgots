import { useState } from "react"
import { CheckCircle2Icon, MapIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"

const CARD = "w-full rounded-3xl border shadow-xl ring-0 shadow-black/10 dark:shadow-black/40"

/** In place of the composer once a plan-mode turn has finished: the plan waits for the user. */
export function PlanReadyCard({
  onApprove,
  onKeepPlanning,
}: {
  onApprove: () => Promise<void>
  onKeepPlanning: () => Promise<void>
}) {
  const [pending, setPending] = useState<"approve" | "keep" | null>(null)
  const run = async (which: "approve" | "keep", action: () => Promise<void>) => {
    setPending(which)
    try {
      await action()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't update the session.")
    } finally {
      setPending(null)
    }
  }
  return (
    <Card size="sm" className={CARD}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MapIcon className="size-5 text-primary" />
          Plan ready
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-[15px]">
          Approve it to let the agent make the changes, or keep planning.
        </p>
      </CardContent>
      <CardFooter className="grid grid-cols-2 gap-2">
        <Button
          size="lg"
          variant="outline"
          className="h-11"
          disabled={pending !== null}
          onClick={() => run("keep", onKeepPlanning)}
        >
          Keep planning
        </Button>
        <Button
          size="lg"
          className="h-11"
          disabled={pending !== null}
          onClick={() => run("approve", onApprove)}
        >
          Approve
        </Button>
      </CardFooter>
    </Card>
  )
}

/** In place of the composer while the session is resolved. */
export function ResolvedCard({ onReopen }: { onReopen: () => void }) {
  return (
    <Card size="sm" className={CARD}>
      <CardContent className="flex items-center gap-3">
        <CheckCircle2Icon className="size-6 shrink-0 text-success" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">This thread is resolved.</p>
          <p className="text-muted-foreground">Reopen it to send more messages.</p>
        </div>
        <Button variant="outline" className="h-11 rounded-full px-4" onClick={onReopen}>
          Reopen
        </Button>
      </CardContent>
    </Card>
  )
}
