export type MediaPart =
  { kind: "text"; at: number; text: string } | { kind: "media"; at: number; paths: string[] }

// Every type the plugin's media route answers with a type of its own (its `media.py` content-type
// map: images, video, audio, text, code and data, the SVG included), so a tag naming one of these
// is a file the host can serve and the thread can draw. The tag still needs its `MEDIA:` prefix and
// an absolute or quoted path, so a list this wide can't swallow prose (and where one extension
// starts another, the longer comes first).
export const SERVED_EXTS = [
  "jpeg png jpg gif webp bmp svg",
  "mp4 m4v mov webm ogv",
  "mp3 m4a aac wav ogg oga opus flac",
  "markdown md txt log csv tsv html htm css xml json pdf yaml yml toml ini",
  "py rb go rs cc cpp hpp cs java kt swift tsx ts jsx js mjs cjs sh bash zsh sql php lua pl r scala exs ex erl hs clj vue svelte dart zig c h",
].flatMap((group) => group.split(" "))
// The tail the same route still hands over as a generic binary — a tag names a file the host can
// serve whatever the host calls it — so the grammar takes these as it takes the types above.
export const BINARY_EXTS = ["zip tar gz docx xlsx pptx epub apk wasm ics vcf srt vtt"].flatMap(
  (group) => group.split(" "),
)
const MEDIA_EXTS = [...SERVED_EXTS, ...BINARY_EXTS].join("|")
const CJK_TERMINATORS = "（）〈〉《》：，。；！？、“”‘’【】"
/**
 * The `MEDIA:<path>` tag shape Hermes's own `MEDIA_TAG_CLEANUP_RE` strips for messaging adapters,
 * limited to the extensions the plugin's media route serves, so a reply draws here whatever file the
 * agent produced there — nothing it can fetch is left as a dead path in the text.
 */
const TAG = new RegExp(
  "[`\"'*_]{0,3}MEDIA:\\s*" +
    "(?<path>`[^`\\n]+?`|\"[^\"\\n]+?\"|'[^'\\n]+?'|" +
    "(?:~/|/|[A-Za-z]:[/\\\\])\\S+?(?:[^\\S\\n]+\\S+?)*?\\.(?:" +
    MEDIA_EXTS +
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
 * Splits a reply into text and the media it names with `MEDIA:<path>` tags: each tag its own part,
 * and the tags sent together (only whitespace between) one part, which draws as one Gallery. What a
 * part's files are — and so where each one draws — is the reader's to say, from the type the host
 * answers. A tag inside a fenced code block is an example, not media, and stays in the text.
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
