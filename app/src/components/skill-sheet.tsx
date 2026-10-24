import { useMemo, useState } from "react"
import { SearchIcon } from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { SkillRow } from "@/components/skill-row"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import type { Skill } from "@/lib/hermes"
import { runnableSkills } from "@/lib/skills-cache"
import { collated } from "@/lib/skills-tab"

/**
 * A bot's skills, to choose from: searchable over the name, the category and the description, one
 * letter at a time, and each row the same as the composer's menu draws. Single-select where the
 * choice is one skill (a step's build skill, a step), multi-select where it's several (the skills a
 * stage applies) — and a multi-select list writes once, on Done, rather than a write a tick.
 *
 * The list is the bot's own, so a skill whose name this build no longer knows still reads as one
 * chosen; it just can't be offered again.
 */
export function SkillSheet({
  open,
  onOpenChange,
  title,
  skills,
  loading,
  multiple = false,
  value,
  onChoose,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  skills: Skill[]
  /** The bot's list is still being read: the sheet says so rather than showing an empty list. */
  loading: boolean
  multiple?: boolean
  /** What is chosen now, so the list opens on the user's choice rather than on a guess. */
  value: string[]
  /** The one skill picked, or the whole set chosen when Done is pressed. */
  onChoose: (names: string[]) => void
}) {
  const [query, setQuery] = useState("")
  const [draft, setDraft] = useState<string[]>(value)
  // Every open starts from what the row holds now: a choice made and undone in a sheet opened
  // before must not come back as a checked row. A write landing under an open sheet is not a new
  // list, so only the open itself resets it.
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) {
      setQuery("")
      setDraft(value)
    }
  }

  const sorted = useMemo(() => {
    const ordered = runnableSkills(skills).sort((one, other) => collated(one.name, other.name))
    const needle = query.trim().toLowerCase()
    if (!needle) return ordered
    return ordered.filter((skill) =>
      [skill.name, skill.category, skill.description].some((field) =>
        field?.toLowerCase().includes(needle),
      ),
    )
  }, [skills, query])

  const pick = (name: string) => {
    if (!multiple) {
      onChoose([name])
      onOpenChange(false)
      return
    }
    setDraft((held) => (held.includes(name) ? held.filter((one) => one !== name) : [...held, name]))
  }

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent initialFocus={false}>
        <PopupHeader className="pb-2">
          <PopupTitle>{title}</PopupTitle>
        </PopupHeader>
        <div className="flex min-h-0 flex-col gap-3 px-4 pb-4 sm:px-6">
          <InputGroup className="h-11">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search skills"
              aria-label="Search skills"
            />
          </InputGroup>
          {loading ? (
            <p className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
              <Spinner className="size-4" /> Reading skills…
            </p>
          ) : sorted.length === 0 ? (
            <p className="px-1 py-2 text-sm text-muted-foreground">
              {query.trim() ? "No skill matches." : "This bot has no skills to offer."}
            </p>
          ) : (
            <ul role="listbox" aria-multiselectable={multiple} aria-label="Skills">
              {sorted.map((skill) => (
                <SkillRow
                  key={skill.name}
                  name={skill.name}
                  category={skill.category}
                  description={skill.description}
                  selected={draft.includes(skill.name)}
                  checked={draft.includes(skill.name)}
                  onPick={() => pick(skill.name)}
                />
              ))}
            </ul>
          )}
          {multiple && (
            <div className="flex justify-end pt-1">
              <Button
                type="button"
                className="h-11"
                onClick={() => {
                  onChoose(draft)
                  onOpenChange(false)
                }}
              >
                Done
              </Button>
            </div>
          )}
        </div>
      </PopupContent>
    </Popup>
  )
}
