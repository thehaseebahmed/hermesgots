import { useSyncExternalStore } from "react"

/** Who listens to a module's own state, for `useSyncExternalStore`: call `notify` after a change. */
export function createSignal() {
  const listeners = new Set<() => void>()
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    notify() {
      listeners.forEach((listener) => listener())
    },
  }
}

/** One value and who listens to it. Setting the value it already holds tells no one. */
export function createStore<T>(initial: T) {
  let value = initial
  const signal = createSignal()
  const get = () => value
  return {
    get,
    set(next: T) {
      if (Object.is(next, value)) return
      value = next
      signal.notify()
    },
    subscribe: signal.subscribe,
    use: () => useSyncExternalStore(signal.subscribe, get),
  }
}
