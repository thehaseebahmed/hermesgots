/**
 * The picture a canvas's list tile draws, from a file the reader chose: one inline image, which is
 * the only shape the host keeps (`canvases.py`'s `_image`). A picture is never a URL — a list that
 * fetched one would be a list reaching outside the app for what it draws — so what goes up is the
 * file's own bytes, and the record's cap is on the whole data URL.
 *
 * A file that already fits goes as it is, so a picture the reader chose is never re-encoded for
 * nothing. A larger one is cut down to a JPEG the tile can still show at its own size, and one that
 * cannot be made to fit is refused in words the sheet can say.
 */

/** The host's cap on a canvas's picture, mirrored from `canvases.py`'s `IMAGE_CHARS`. */
export const IMAGE_CHARS = 192 * 1024

/**
 * The long edges a picture is cut down to, largest first: the tile is 4:3 and a list holds many, so
 * a portrait photograph is no taller than this on its long side. The second is tried only where the
 * first still lands over the host's cap.
 */
const EDGES = [512, 320]

const QUALITY = 0.82

/** What a file that isn't a picture is refused with. */
export const NOT_A_PICTURE = "A canvas's picture is an image file."

/** What a picture the browser can't decode is refused with. */
export const UNREADABLE_PICTURE = "That picture couldn't be read."

/** What a picture that can't be made small enough is refused with, over the host's own number. */
export const PICTURE_TOO_BIG = `That picture is too big to keep — a canvas's picture is at most ${IMAGE_CHARS / 1024} KB.`

/** One blob as the data URL a record holds. */
function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error(UNREADABLE_PICTURE))
    reader.readAsDataURL(blob)
  })
}

/** One bitmap as a JPEG no longer than `edge` on its long side. */
async function jpegOf(bitmap: ImageBitmap, edge: number): Promise<string> {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext("2d")
  if (!context) throw new Error(UNREADABLE_PICTURE)
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", QUALITY),
  )
  if (!blob) throw new Error(UNREADABLE_PICTURE)
  return await dataUrlOf(blob)
}

/**
 * One file as the picture a canvas's record keeps: its own bytes where they fit, a smaller JPEG
 * where they don't, and a refusal in plain words where no version of it can.
 */
export async function inlinePicture(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error(NOT_A_PICTURE)
  const whole = await dataUrlOf(file)
  if (whole.length <= IMAGE_CHARS) return whole
  // Decoded once and cut at each edge, rather than decoded again for the second: a photograph is
  // tens of megabytes of pixels, and both edges are the same picture.
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(UNREADABLE_PICTURE)
  }
  try {
    for (const edge of EDGES) {
      const smaller = await jpegOf(bitmap, edge)
      if (smaller.length <= IMAGE_CHARS) return smaller
    }
  } finally {
    // A decoded picture holds its memory until it is let go, and a list of them would hold a lot.
    bitmap.close()
  }
  throw new Error(PICTURE_TOO_BIG)
}
