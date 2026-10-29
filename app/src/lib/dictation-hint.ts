/**
 * The words a dictation is told the chat is about, so a name it would otherwise hear as a common
 * word comes back as written: the chat's title, the project it belongs to and the repositories it
 * works in, each by its last path segment, comma-separated, with whatever the chat lacks left out.
 */
export function dictationHint({
  title,
  project,
  repos = [],
}: {
  title?: string
  project?: string
  repos?: { name: string }[]
}) {
  return [title, project, ...repos.map((repo) => repo.name.split("/").pop())]
    .filter(Boolean)
    .join(", ")
}
