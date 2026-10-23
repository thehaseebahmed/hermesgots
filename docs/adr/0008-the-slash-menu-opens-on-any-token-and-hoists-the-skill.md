# The slash menu opens on any token, and hoists a picked skill to the message's front

*Superseded in part by [ADR 0015](./0015-goal-mode-is-removed-and-nothing-replaces-it.md): `goal` is
no longer one of the commands this record describes — it has left the menu, the composer's command
list and the wizard whose review picker read the skill list. Everything here about commands and
skills stands.*

*Superseded in part by [ADR 0037](./0037-a-picked-skill-lands-where-the-cursor-is.md): a picked
skill is no longer hoisted to the front of the message — it lands where the cursor is, because the
front-of-message rule belongs to host surfaces this app never sends through. The hoist below stood
on a premise this app's own transport disproves; 0037 carries the evidence.*

The composer's slash menu used to need the slash at the very start of the composer with nothing after
it but a single word — `/gri` opened it, `/grill the tests` and `fix /grill` did not. Discovery was
therefore limited to the one position where a skill is also _invocable_, and a skill whose name the
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
throw the sentence away, so a command is offered only when its token is the whole message — the same
shape the composer's own actions already require of it (`localCommand`, `goalCommand`), which is what
keeps the menu from offering something that acting on would silently drop the rest of. The menu's
commands are the ones the composer's own actions own; everything else a slash can reach is a skill.

The list is filtered by name, category and description, ranked in tiers: an exact name first, then a
name the query starts, then a name that contains it, then a fuzzy (subsequence) name match, then a
category match, then a description match. Ties keep the plugin's own order. A caret on the slash
itself is inside the token, so the query is empty and the menu lists everything; a pick rewrites that
token whole, and typing there inserts in front of the slash either way, so the boundary is left as it
falls rather than closed. Escape closes the menu until the text changes; when nothing matches, the menu
is not shown.

The bot's skills are cached on the device, one last-known list per bot, so the menu opens with the
skills already in it and refetches in the background; the list a read brings replaces the one held, and
a read that brings nothing — a failed host, a plugin with no route — leaves the held list in place, or
shows the commands alone when there is none, rather than a menu waiting on a read that already ended. A
plugin that has no skills route is left alone for `MISSING_ROUTE_MS` like every other route-missing read
in the app, rather than re-asked at each open. What the menu shows from all that is one pure rule
(`skills-cache.ts`), so the cases that depend on which answer arrived first are pinned by a test. The
goal wizard's review picker reads the same cached list.

The list is as tall as the room above the composer and never more than 45% of what's on screen, up to
the 288px it has always been. On a phone with the keyboard up that is about four rows, which scroll;
on a tablet or a desktop nothing changes.

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
- **`localStorage` for the cached list**, which needs no schema change. Rejected: a skill list is per
  bot, and the place a bot's own state lives is the database that syncs and deletes with it — the
  per-connection caches that exist today are this page's memory, not the device's, so a reload threw
  them away; the device-only keys are for settings the user picked, and deleting a bot has to take its
  list with it.
- **Refetching only after a TTL, or only when the plugin's version moves.** Rejected: a refresh on each
  open is one request behind a menu the user just asked for, and a TTL leaves a skill installed minutes
  ago invisible for as long as the window lasts.
- **A fixed height for the list** (the 288px it had). Rejected: on a phone the keyboard can leave about
  500px of screen, and a list that tall puts its first rows above the top of it, where nothing scrolls
  them back into reach.
- **`hasPluginFeature` to decide whether to ask for skills at all.** Rejected: it answers `false` for a
  host that couldn't be reached just as it does for a plugin that lacks the route, so a blip would read
  as "this bot has no skills" and empty a menu that had them; `lacksRoute` is the one that tells the two
  apart, and only a route the plugin really lacks leaves the commands alone.

## Consequences

- A skill the user installed moments ago appears the second time the menu is opened, on a device that
  already has a list; the first open on a fresh device shows the commands and the loading line.
- A bot whose plugin has no skills route (an older plugin) keeps the commands and shows no skills, and
  never an error, as before. A bot that is merely unreachable keeps what it had: the cached list stands
  and the menu goes on working without the host, which is what "kept on failure" has to mean.
- The slash menu's entries, the token rules and the ranking are pure functions of the text, the cursor
  and the cached list, so they can be tested without a browser and without a bot; the composer keeps
  only the wiring.
- The message a hoist produces is the one the old menu produced for the same skill: `/name ` followed
  by the rest, so a bot's host sees no difference between a picked skill and a typed one.
- The Dexie schema gains a table, so it is bumped once, with existing device data loading untouched.
- `GLOSSARY.md` now separates a **Command** (Gots acting) from a **Skill** (the bot's profile acting),
  which is the distinction the composer's code had been carrying as one word.
