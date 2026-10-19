import { getFallbackModels, setFallbackModels, type Fallback } from "@/lib/hermes"
import { useHostRecord, type HostRoute } from "@/lib/host-record"

const FALLBACKS: HostRoute<Fallback[]> = {
  feature: "fallbacks",
  label: "the fallback models",
  read: getFallbackModels,
  write: setFallbackModels,
}

export function useFallbackModels(profile?: { baseUrl: string; apiKey: string } | null) {
  const { value: list, supported, saving, save } = useHostRecord(profile, FALLBACKS, [])
  return { list, supported, saving, save }
}
