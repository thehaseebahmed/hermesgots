/**
 * PNG, read and written over `node:zlib` alone.
 *
 * This is not a general PNG library. It reads the two shapes this repository actually carries — a
 * non-interlaced, 8-bit image of colour type 2 (RGB, `public/pwa-192x192.png`) or 6 (RGBA,
 * `public/bots/<id>/happy.png`) — and refuses anything else by name rather than draw it wrong. On
 * write it emits one shape only: colour type 6, 8-bit, non-interlaced, every row filtered 0, and no
 * chunk but `IHDR`, `IDAT` and `IEND` — no timestamp, no text, no library signature — so the same
 * image encodes to the same bytes on every run, and a committed file can be compared with a fresh
 * render and be equal.
 *
 * Pixels are RGBA throughout, 8 bits a channel, in one `Uint8Array` of `width * height * 4` bytes:
 * an `Image` is `{ width, height, data }`. A reader that wants a colour gets all four channels,
 * because the alternative — an image whose shape decides how it is indexed — is what makes a
 * compositor carry two paths.
 */
import { crc32, deflateSync, inflateSync } from "node:zlib"

/** The eight bytes every PNG starts with. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The channels each colour type this module reads carries. */
const CHANNELS = { 2: 3, 6: 4 }

/**
 * An image as this module hands it out and takes it in: RGBA, 8 bits a channel, row-major from the
 * top-left. Never mutated in place by anything here.
 *
 * @typedef {{ width: number, height: number, data: Uint8Array }} Image
 */

/**
 * The bytes a PNG holds, as an RGBA image.
 *
 * @param {Uint8Array} bytes
 * @returns {Image}
 */
export function decode(bytes) {
  const file = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (file.length < SIGNATURE.length || !SIGNATURE.equals(file.subarray(0, 8)))
    throw new Error("not a PNG: the signature is missing")
  let header = null
  const parts = []
  for (let at = 8; at < file.length; ) {
    if (at + 8 > file.length) throw new Error("truncated PNG: a chunk's length or name is cut")
    const length = file.readUInt32BE(at)
    const name = file.toString("latin1", at + 4, at + 8)
    const end = at + 8 + length
    if (end + 4 > file.length) throw new Error(`truncated PNG: ${name} runs past the file`)
    const body = file.subarray(at + 8, end)
    if (crc32(file.subarray(at + 4, end)) >>> 0 !== file.readUInt32BE(end))
      throw new Error(`corrupt PNG: ${name}'s checksum does not match its bytes`)
    if (name === "IHDR") header = readHeader(body)
    else if (name === "IDAT") parts.push(body)
    else if (name === "IEND") break
    at = end + 4
  }
  if (!header) throw new Error("not a PNG: it carries no IHDR")
  if (!parts.length) throw new Error("not a PNG: it carries no IDAT")

  const { width, height, channels } = header
  const rows = inflateSync(Buffer.concat(parts))
  const stride = width * channels
  if (rows.length !== height * (stride + 1))
    throw new Error(`cut PNG: ${rows.length} bytes of pixels where ${height} rows of ${stride} take ${height * (stride + 1)}`)

  // Unfiltered in place, a row at a time, since each row is read against the one above it.
  const plain = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = rows[y * (stride + 1)]
    const line = rows.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const above = y ? plain.subarray((y - 1) * stride, y * stride) : null
    const out = plain.subarray(y * stride, (y + 1) * stride)
    unfilter(filter, line, out, above, channels)
  }

  const data = new Uint8Array(width * height * 4)
  for (let i = 0, at = 0; i < width * height; i++, at += channels) {
    data[i * 4] = plain[at]
    data[i * 4 + 1] = plain[at + 1]
    data[i * 4 + 2] = plain[at + 2]
    data[i * 4 + 3] = channels === 4 ? plain[at + 3] : 0xff
  }
  return { width, height, data }
}

/**
 * The bytes an image encodes to: colour type 6, every row filtered 0, and nothing but the three
 * chunks a decoder needs. The same image encodes to the same bytes, every run — which is what makes
 * a committed badged avatar a check rather than a claim.
 *
 * @param {Image} image
 * @returns {Buffer}
 */
export function encode({ width, height, data }) {
  if (data.length !== width * height * 4)
    throw new Error(`${width}x${height} takes ${width * height * 4} bytes of RGBA, got ${data.length}`)

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  header[10] = 0 // compression: deflate
  header[11] = 0 // filter method: the adaptive five
  header[12] = 0 // interlace: none

  const stride = width * 4
  const rows = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    rows[y * (stride + 1)] = 0
    rows.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/**
 * An image at another size, nearest neighbour: every destination pixel is the source pixel its
 * centre lands on, so a small mark cut from a larger icon keeps that icon's own colours rather than
 * a blur of its neighbours' — the badge is cut once and read by three platforms, and none of them
 * should see a colour the icon does not have. Shrinking by a whole number is the case in the tree;
 * the arithmetic holds for any ratio.
 *
 * @param {Image} image
 * @param {number} width
 * @param {number} height
 * @returns {Image}
 */
export function scale({ width, height, data }, toWidth, toHeight) {
  const out = new Uint8Array(toWidth * toHeight * 4)
  for (let y = 0; y < toHeight; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / toHeight))
    for (let x = 0; x < toWidth; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / toWidth))
      const from = (sy * width + sx) * 4
      const to = (y * toWidth + x) * 4
      out[to] = data[from]
      out[to + 1] = data[from + 1]
      out[to + 2] = data[from + 2]
      out[to + 3] = data[from + 3]
    }
  }
  return { width: toWidth, height: toHeight, data: out }
}

/** The IHDR of a file this module reads, or a refusal naming what it is instead. */
function readHeader(body) {
  const width = body.readUInt32BE(0)
  const height = body.readUInt32BE(4)
  const [depth, colour, compression, filter, interlace] = body.subarray(8, 13)
  if (!CHANNELS[colour])
    throw new Error(`a PNG of colour type ${colour} is not one this reader carries (2 or 6)`)
  if (depth !== 8) throw new Error(`a ${depth}-bit PNG is not one this reader carries (8)`)
  if (compression !== 0 || filter !== 0) throw new Error("a PNG with an unknown compression or filter method")
  if (interlace !== 0) throw new Error("an interlaced PNG is not one this reader carries")
  return { width, height, channels: CHANNELS[colour] }
}

/**
 * One row's filter undone, `line` in and `out` written, with the row above it in `above` where
 * there is one. The five filters PNG defines, and a refusal for the sixth byte value, since a file
 * carrying one is corrupted rather than readable.
 */
function unfilter(filter, line, out, above, bytes) {
  switch (filter) {
    case 0: // None
      out.set(line)
      return
    case 1: // Sub: each byte against the one `bytes` to its left
      for (let i = 0; i < line.length; i++) out[i] = (line[i] + (i >= bytes ? out[i - bytes] : 0)) & 0xff
      return
    case 2: // Up: each byte against the one above it
      for (let i = 0; i < line.length; i++) out[i] = (line[i] + (above ? above[i] : 0)) & 0xff
      return
    case 3: // Average: half of the two
      for (let i = 0; i < line.length; i++) {
        const left = i >= bytes ? out[i - bytes] : 0
        out[i] = (line[i] + ((left + (above ? above[i] : 0)) >> 1)) & 0xff
      }
      return
    case 4: // Paeth: whichever of the three neighbours the predictor lands nearest
      for (let i = 0; i < line.length; i++) {
        const left = i >= bytes ? out[i - bytes] : 0
        const up = above ? above[i] : 0
        const upLeft = above && i >= bytes ? above[i - bytes] : 0
        out[i] = (line[i] + paeth(left, up, upLeft)) & 0xff
      }
      return
    default:
      throw new Error(`corrupt PNG: filter type ${filter} on a row`)
  }
}

/** PNG's predictor for the byte left of, above and above-left of the one being written. */
function paeth(left, up, upLeft) {
  const guess = left + up - upLeft
  const toLeft = Math.abs(guess - left)
  const toUp = Math.abs(guess - up)
  const toUpLeft = Math.abs(guess - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) return left
  return toUp <= toUpLeft ? up : upLeft
}

/** A chunk, with its length and its CRC over the name and the body. */
function chunk(name, body) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(name, 4, "latin1")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0)
  return Buffer.concat([head, body, crc])
}
