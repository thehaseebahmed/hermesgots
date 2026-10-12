import { createContext, useContext, useEffect } from "react"

export const BreakReminderActivityContext = createContext<(active: boolean) => void>(
  () => undefined,
)

export function useBreakReminderEligibility(active: boolean) {
  const report = useContext(BreakReminderActivityContext)
  useEffect(() => {
    report(active)
    return () => report(false)
  }, [active, report])
}
