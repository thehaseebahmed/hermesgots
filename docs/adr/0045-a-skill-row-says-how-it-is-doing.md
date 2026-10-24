# A skill row says how it is doing, and the tab holds what the profile can

**Amended 2026-10-24**: the row's category moved up to the group title it sits under, and the
sheet's own lines became one properties block (where it came from, Readiness and Setup beside the
SKILL.md's frontmatter) over the file's words as prose — the re-grilled design in
`docs/specs/skills-tab.md`. What follows reads as amended.

The Skills tab is the MCP list's reasoning applied to skills. A row is its name and its description,
the category title it sits under saying which category, with the state in prose under it — `Ready`, `Off`, or `Doesn't load` with the host's own
reason — because a badge is a word off a list the user has to learn. The two sections are *Your
skills* and *From plugins*, and a heading with nothing under it is dropped. Inside them the rows are
grouped by the skills' categories, alphabetically, with *No category* last.

What the tab holds is everything the profile can — built in, from the Hub, yours, from a plugin —
including skills that are off and skills that don't load: a skill that doesn't load is one the user
can only fix by taking away. A repository's own skills are the project's, not the bot's, so they
stay out, and a name another copy shadows is a duplicate the user cannot act on.

What one skill holds is its own sheet, like a server's: a properties block first — where the skill
came from (Built in, Installed from the Hub, Yours, From a plugin), the host's Readiness and Setup
where it has them, beside every key the SKILL.md's own frontmatter holds — then the file's words as
prose, and its linked files each viewable below it. The row is a summary; the sheet is the thing
itself.

## Consequences

- The switch follows what the Host honours, not the section: a plugin skill has one, because Hermes
  honours its disabled name, while a built-in the host protects (essential) has none at all. Remove
  likewise appears only where the origin has a real removal behind it ([ADR 0044](./0044-a-bots-skills-are-managed-through-hermes-own-skill-machinery.md)),
  and is called Remove in one word whatever the underlying operation.
- The sheet's linked files are read from the host when the sheet opens, so opening one is a read of
  that skill alone, never of the whole directory.
- A tab whose host cannot list skills does not exist: the `skills` feature gates the tab itself, and
  `skills_write`, `skills_remove` and `skills_view` gate the switch, the removal and the sheet.
