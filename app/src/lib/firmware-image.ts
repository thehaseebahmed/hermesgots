/**
 * The image a firmware update is sent from, read as it lands: the whole's length and the bytes
 * received so far, so the update screen's Downloading step draws the host's own answer rather
 * than a spinner over a megabyte and a half.
 *
 * Import-free, so `scripts/test-firmware-image.mjs` runs it as a pure rule; the fetch that hands
 * it a Response is `getCharmFirmwareImage`'s own business.
 */
export interface FirmwareImageProgress {
  received: number
  total: number
}

/**
 * Reads a served image through its body's reader, reporting every chunk as it lands. `total` is
 * the whole the length header named, and zero where none did — the reader counts what it holds
 * rather than claiming a whole nobody stated.
 */
export async function readFirmwareImage(
  response: Response,
  onProgress?: (progress: FirmwareImageProgress) => void,
): Promise<Uint8Array> {
  const total = Number(response.headers.get("Content-Length")) || 0
  const body = response.body
  // A proxy or an old runtime can hand back no reader; the bytes are still the image, so they are
  // read the one remaining way rather than refused.
  if (!body) return new Uint8Array(await response.arrayBuffer())
  const parts: Uint8Array[] = []
  let received = 0
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    received += value.length
    onProgress?.({ received, total })
  }
  const image = new Uint8Array(received)
  let at = 0
  for (const part of parts) {
    image.set(part, at)
    at += part.length
  }
  return image
}
