export type MediaPart =
  { kind: "text"; at: number; text: string } | { kind: "media"; at: number; paths: string[] }

// Raster formats the plugin serves (its `MEDIA_TYPES` map), longest first like Hermes's own
// extension alternation.
const IMAGE_EXTS = "jpeg|png|jpg|gif|webp|bmp"
const CJK_TERMINATORS = "（）〈〉《》：，。；！？、“”‘’【】"
/**
 * The `MEDIA:<path>` tag shape Hermes's own `MEDIA_TAG_CLEANUP_RE` strips for messaging adapters,
 * narrowed to the image extensions, so a reply shows here exactly the images it would send there.
 */
const TAG = new RegExp(
  "[`\"'*_]{0,3}MEDIA:\\s*" +
    "(?<path>`[^`\\n]+?`|\"[^\"\\n]+?\"|'[^'\\n]+?'|" +
    "(?:~/|/|[A-Za-z]:[/\\\\])\\S+?(?:[^\\S\\n]+\\S+?)*?\\.(?:" +
    IMAGE_EXTS +
    "))" +
    "(?=[\\s`\"'*_,;:)\\]\\[}\\" +
    CJK_TERMINATORS +
    "]|MEDIA:|\\.(?:\\s|$)|$)[`\"'*_]{0,3}\\.?",
  "gi",
)

function unquote(path: string) {
  const first = path[0]
  return path.length > 1 &&
    (first === "`" || first === '"' || first === "'") &&
    path.at(-1) === first
    ? path.slice(1, -1)
    : path
}

function scan(slice: string, at: number, parts: MediaPart[]) {
  let last = 0
  for (const match of slice.matchAll(TAG)) {
    const index = match.index ?? 0
    if (index > last) parts.push({ kind: "text", at: at + last, text: slice.slice(last, index) })
    parts.push({
      kind: "media",
      at: at + index,
      paths: [unquote(match.groups?.path ?? "")],
    })
    last = index + match[0].length
  }
  if (last < slice.length) parts.push({ kind: "text", at: at + last, text: slice.slice(last) })
}

/** Tags sent together — only whitespace between them — come out as one part: a gallery. */
function group(parts: MediaPart[]): MediaPart[] {
  const grouped: MediaPart[] = []
  let run: { at: number; paths: string[] } | null = null
  for (const part of parts) {
    if (part.kind === "media") {
      if (run) run.paths.push(...part.paths)
      else run = { at: part.at, paths: [...part.paths] }
    } else if (part.text.trim()) {
      if (run) {
        grouped.push({ kind: "media", ...run })
        run = null
      }
      grouped.push(part)
    }
  }
  if (run) grouped.push({ kind: "media", ...run })
  return grouped
}

/**
 * Splits a reply into text and the images it names with `MEDIA:<path>` tags: each tag its own part,
 * and the tags sent together (only whitespace between) one gallery part. A tag inside a fenced code
 * block is an example, not an image, and stays in the text.
 */
export function mediaImages(text: string): MediaPart[] {
  const parts: MediaPart[] = []
  let offset = 0
  let plainFrom = 0
  let fence: string | null = null
  let fencedFrom = 0
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]?.[0] ?? null
    if (marker) {
      if (!fence) {
        scan(text.slice(plainFrom, offset), plainFrom, parts)
        fence = marker
        fencedFrom = offset
      } else if (marker === fence) {
        fence = null
        parts.push({
          kind: "text",
          at: fencedFrom,
          text: text.slice(fencedFrom, offset + line.length),
        })
        plainFrom = offset + line.length + 1
      }
    }
    offset += line.length + 1
  }
  if (fence) parts.push({ kind: "text", at: fencedFrom, text: text.slice(fencedFrom) })
  else scan(text.slice(plainFrom), plainFrom, parts)
  return group(parts)
}
