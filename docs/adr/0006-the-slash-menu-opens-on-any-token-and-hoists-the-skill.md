# The slash menu opens on any token, and hoists a picked skill to the message's front

The composer's slash menu used to need the slash at the very start of the composer with nothing after
it but a single word — `/gri` opened it, `/grill the tests` and `fix /grill` did not. Discovery was
therefore limited to the one position where a skill is also *invocable*, and a skill whose name the
user half-remembers could only be found by starting the message over. The menu now opens from a slash
that begins any token: the start of the message, or just after a space or a newline. The query is that
token up to the cursor, and only that token is rewritten when something is picked. A slash inside a
word (`and/or`, `https://…`, `/usr/local/bin`) never opens it — the token must start there — and nor
does a token whose query already holds a slash, which is a path being typed rather than a command.

A skill is invocable only from the front of a message, and a skill picked mid-sentence would otherwise
be sent as plain text and silently fail to run. So picking one **hoists** it: `/name ` goes to the very
front of the message and whatever was already typed follows it. The menu therefore offers a skill from
anywhere, and the composer guarantees the position the bot's host needs.

Commands are not treated this way. `new`, `goal` and `settings` run immediately and clear the composer,
and `steer` and `queue` change how the message is sent; picking one from the middle of a sentence would
throw the sentence away, so commands match only when their token is the message's first text. The
menu's commands are the ones the composer's own actions own; everything else a slash can reach is a
skill.

The list is filtered by name, category and description, ranked in tiers: an exact name first, then a
name the query starts, then a name that contains it, then a fuzzy (subsequence) name match, then a
category match, then a description match. Ties keep the plugin's own order. Escape closes the menu for
that token until its text changes; when nothing matches, the menu is not shown.

The bot's skills are cached on the device, one last-known list per bot, so the menu opens with the
skills already in it and refetches in the background; a failed read leaves the cached list in place. The
goal wizard's review picker reads the same cached list.

## Considered options

- **Inserting the skill where the cursor is.** Rejected: a slash anywhere but the front of the message
  isn't a skill invocation, so the message would arrive as ordinary text and the user would believe a
  skill had run. Hoisting is the only option that makes "a slash anywhere" honest.
- **Replacing the whole composer with `/name `**, as the old pick did. Rejected: it discards the
  sentence the user was writing, which is exactly the case the anywhere-trigger creates.
- **Opening on any slash, mid-word included.** Rejected: URLs, paths and `and/or` are slashes users
  type on purpose, and a menu that appears inside them is a menu that fights the keyboard.
- **Closing the menu when the token gets a space, rather than on a pick or Escape.** Rejected: the
  token's text is the query, so a space ends the token anyway, and a dismissal the user asked for
  should outlive the keystroke that follows it.
- **Edit distance as the fuzzy tier** (a name within one or two typos of the query). Rejected:
  subsequence already covers the case that matters — a dropped or reordered character while typing a
  name from memory — and edit distance also drags in short names the user never meant.
- **One weighted fuzzy score** (name weighted over category and description). Rejected: with a few
  dozen skills the score's tuning is invisible and untestable, while "exact, then prefix, then
  substring, then fuzzy" is a rule a reader can predict and a test can pin.
- **Commands folded into the same ranking.** Rejected: a skill sharing a command's initial letters
  could outrank it, and the two do different things — one is sent to the bot, the other is Gots acting.
- **Commands matching from any token.** Rejected: `/new` typed mid-sentence would run and clear a draft
  the user is still writing.
- **`localStorage` for the cached list**, which needs no schema change. Rejected: bots already have a
  per-connection cache convention in Dexie, and a skill list is per bot and belongs with the rest of
  what a bot owns rather than beside the device-only settings keys.
- **Refetching only after a TTL, or only when the plugin's version moves.** Rejected: a refresh on each
  open is one request behind a menu the user just asked for, and a TTL leaves a skill installed minutes
  ago invisible for as long as the window lasts.

## Consequences

- A skill the user installed moments ago appears the second time the menu is opened, on a device that
  already has a list; the first open on a fresh device shows the commands and the loading line.
- A bot that can't list skills (an older plugin, a host that errors) keeps the commands and shows no
  skills, and never an error, as before — the cache holds what was last known rather than a failure.
- The slash menu's entries, the token rules and the ranking are pure functions of the text, the cursor
  and the cached list, so they can be tested without a browser and without a bot; the composer keeps
  only the wiring.
- The message a hoist produces is the one the old menu produced for the same skill: `/name ` followed
  by the rest, so a bot's host sees no difference between a picked skill and a typed one.
- The Dexie schema gains a table, so it is bumped once, with existing device data loading untouched.
- `GLOSSARY.md` now separates a **Command** (Gots acting) from a **Skill** (the bot's profile acting),
  which is the distinction the composer's code had been carrying as one word.
