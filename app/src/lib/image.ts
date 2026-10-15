import { useState } from "react"

/**
 * Whether an image is ready to show, and the handlers that say so. The skeleton stands until the
 * load or the error lands — an image that can't be read must not leave its place pulsing forever.
 * A new `src` starts over, so an image swapping under the same element waits for its own bytes.
 */
export function useImageReady(src: string) {
  const [ready, setReady] = useState(false)
  const [loaded, setLoaded] = useState(src)
  if (loaded !== src) {
    setLoaded(src)
    setReady(false)
  }
  return { ready, onLoad: () => setReady(true), onError: () => setReady(true) }
}
