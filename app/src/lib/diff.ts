/** Reads `git diff` output into files and numbered lines. */

export interface DiffLine {
  kind: "add" | "del" | "context" | "hunk" | "note"
  text: string
  oldNo?: number
  newNo?: number
}

export interface DiffFile {
  path: string
  /** The path before a rename. */
  oldPath?: string
  status: "added" | "deleted" | "renamed" | "modified"
  binary: boolean
  additions: number
  deletions: number
  lines: DiffLine[]
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** `a/src/x.ts` → `src/x.ts`; null for /dev/null. */
function side(path: string) {
  const trimmed = path.replace(/\t.*$/, "")
  if (trimmed === "/dev/null") return null
  return trimmed.replace(/^"?[ab]\//, "").replace(/"$/, "")
}

function parseFile(chunk: string[]): DiffFile {
  // `diff --git a/x b/x`; quoted or spaced names are taken from the ---/+++ lines below instead.
  const header = /^diff --git a\/(.*) b\/(.*)$/.exec(chunk[0])
  const file: DiffFile = {
    path: header?.[2] ?? "",
    status: "modified",
    binary: false,
    additions: 0,
    deletions: 0,
    lines: [],
  }
  let from: string | null | undefined
  let to: string | null | undefined
  let oldNo = 0
  let newNo = 0
  let inHunks = false
  for (const line of chunk.slice(1)) {
    const hunk = HUNK.exec(line)
    if (hunk) {
      inHunks = true
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      file.lines.push({ kind: "hunk", text: line })
      continue
    }
    if (!inHunks) {
      if (line.startsWith("new file mode")) file.status = "added"
      else if (line.startsWith("deleted file mode")) file.status = "deleted"
      else if (line.startsWith("rename from ")) file.oldPath = line.slice(12)
      else if (line.startsWith("rename to ")) file.path = line.slice(10)
      else if (line.startsWith("Binary files ")) file.binary = true
      else if (line.startsWith("--- ")) from = side(line.slice(4))
      else if (line.startsWith("+++ ")) to = side(line.slice(4))
      continue
    }
    if (line.startsWith("+")) {
      file.additions++
      file.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ })
    } else if (line.startsWith("-")) {
      file.deletions++
      file.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ })
    } else if (line.startsWith("\\")) {
      file.lines.push({ kind: "note", text: line.slice(2) })
    } else {
      file.lines.push({ kind: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
  }
  if (to) file.path = to
  else if (from) file.path = from
  if (file.oldPath && file.oldPath !== file.path) file.status = "renamed"
  else file.oldPath = undefined
  return file
}

export function parseDiff(text: string): DiffFile[] {
  const chunks: string[][] = []
  const lines = text.replace(/\n$/, "").split("\n")
  for (const line of lines) {
    if (line.startsWith("diff --git ")) chunks.push([line])
    else chunks.at(-1)?.push(line)
  }
  return chunks.map(parseFile)
}
