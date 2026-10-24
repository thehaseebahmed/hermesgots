import { Suspense, lazy, type ComponentType, type ReactNode } from "react"

/**
 * The box a drawn interface takes in the thread. Charts, maps and the placeholder each shows while
 * its code arrives all wear it, so a landing chunk can never disagree with the fallback it replaces.
 */
export const SURFACE_FRAME = "h-56 w-full min-w-0"

/**
 * A surface arrives with its library — Recharts or Leaflet, ~100kB either way — and most replies
 * draw none, so each is a lazy import behind this. The placeholder is the caller's: what stands in
 * the frame's place carries its own `aria`.
 */
export function lazySurface<P extends object>(
  loader: () => Promise<{ default: ComponentType<P> }>,
  placeholder: ReactNode,
) {
  const Surface = lazy(loader)
  return function LazySurface(props: P) {
    return (
      <Suspense fallback={placeholder}>
        <Surface {...props} />
      </Suspense>
    )
  }
}
