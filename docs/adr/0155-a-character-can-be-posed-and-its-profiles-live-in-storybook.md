---
status: accepted
---

# A character can be posed, and the characters' profiles live in Storybook

Every bot was one picture with a looping motion. Crumb, Bubble and Pixel arrived with six poses, one per mood, and
Lovey, Byte, Pip, Sunny, Nova and Wink followed; the other characters will be redrawn the same way one by one, so the
app needs a way to draw a character by how it feels and a place to look at all of them.

**A character is still or posed.** A still one keeps `public/bots/<id>.png` and its `.bot-anim-<id>`
motion. A posed one (`posed: true` in `bots.tsx`) has `public/bots/<id>/<mood>.png` for each of six
moods, and its still is the happy pose, so every list that draws a bot small needs nothing new. The
moods are one list for every character (`BOT_MOODS`), so a character moved over later is drawn by the
same callers.

**Moods are the caller's, and only where the bot is animated.** The header and the empty-state hero
are the two places a bot moves, so they are the two that choose a mood: the hero waves, and the
header is sleepy while its host is away. The mood is never stored or synced. Waiting on the reader
(curious) and a finished task (excited) are the next two and want a signal the screens do not hold
in one place yet.

**A change of mood is a poof, built from transitions.dev.** Both poses sit in one cell (its icon
swap, already the list foot's), so the old pose shrinks and blurs out while the new one grows in over
it, each keeping its own idle motion, and the body squashes and throws a puff of smoke (its like
button's pop and particle burst). The first version hand-wrote the motion as three sequential
animations with an empty beat between them; the snippets overlap the two poses instead, so nothing
blinks, and their tuning lives in the stylesheet's variables. A mood asked for while one is changing
waits, and only the newest is shown. With reduced motion the pose is swapped and nothing moves. Six
other transitions were tried (squish, sparkle, flip, drop, flash, fade); the poof was chosen.

**No colour per mood.** A tint and a glow per mood were tried and left out: the characters' colours
are their identity.

**The Bots screen is gone.** It was a gallery nothing linked to. Its job moves to Storybook's
Characters (`bot.stories.tsx`): every character's whole profile, a posed one's moods and its poof.
A character's longer profile and its source art are kept in the gots-universe repository, since they
are not the app's.

## Considered options

- **One sprite sheet per character.** One request instead of six. Rejected: the poses are the size
  of the other characters' pictures, a separate file per mood needs no slicing, and the poses are
  fetched together when a posed bot first animates.
- **Keep the Bots screen.** Rejected: nothing in the app opened it, and a gallery with moods and
  profiles is a developer's page.

## Amendment: the one-picture characters are retired

The other characters were redrawn all at once rather than one by one, so the app has nine, every one
posed, and `posed` and the one-picture path are gone. Each retired character maps onto the new one with
its shape (`LEGACY_BOT_IDS`): Cubby to Bubble, Tri to Pixel, Penny to Wink, Hex to Byte, Stella to
Sunny, Orbi to Pip, Gem to Nova, Bloom to Lovey, and the ids from before them the same way. The eight
map to eight different characters, so two bots a user kept apart stay apart. Dexie v49 rewrites the
stored ids and `botIdOf` reads the map wherever an id may still arrive — a bot record another device
wrote before it updated, a host's push icon — so nothing draws a picture that is gone. A device on an
older build that reads a new id falls back to its first character, which is the cost of not versioning
the synced record.
