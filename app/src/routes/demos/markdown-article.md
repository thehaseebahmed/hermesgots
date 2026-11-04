# Every element, in one reply

You asked what a reply can draw, so here is one of each, in the order a reply tends to use them. Read the words as scaffolding: they are only here to give every shape something to hold.

## Headings

A reply's first heading is the one level the app raises to a size of its own. The second is the body's size with a weight on it.

### A third level labels a part of the answer

Three levels are what a reply usually needs, and the app styles exactly those three. What a fourth does is worth seeing, so it is at the foot under _Edge cases_.

## Words inside a line

Bold **holds a word still**, italic _leans on one_, and _**both at once**_ is what a warning gets. A struck clause ~~like this one~~ keeps its trail, and a code span keeps its own fill: `pnpm typecheck`.

A link is [underlined rather than coloured](https://hermes-agent.nousresearch.com/docs), so it reads as ordinary words until you go looking for it. A bare address is picked up on its own, https://hermesgots.dev, and so is one written in angle brackets, <https://example.com>.

A line can end in two spaces  
and the next one starts under it: that is how a reply breaks a line without starting a new paragraph. A message on its bubble has no need of it, since the bubble keeps every newline a person typed.

## Lists

Three things, said loosely enough that each is its own paragraph:

- the first thing, which is short
- the second thing, which is long enough to wrap on a phone and to show that the marker stays beside the first line of its item rather than drifting to the last

- a third item set off by a blank line, which is how a loose list is written

And one that counts:

1. the first
2. the second
3. the third

Nesting repeats the same marker at every depth, so the indent is the only thing saying how deep you are:

- a top-level item
  - one level in
    - two levels in
- and back out again

What is done and what is not:

- [x] every element written down once
- [ ] the ones the renderer draws its own way

## Quotes

> A reply quoting what it was told keeps a rule down its left edge, in the body's own colour rather than a tint of its own.
>
> A second paragraph in the same quote keeps the same rule beside it, because every line of it still starts with the marker. Leave the marker off one line and the quote ends there instead, which is markdown's own rule rather than the app's.
>
> > And a quote inside a quote steps in again, with the same rule at every level.

## Code

A fence with a language is the shape a reply uses for anything that runs:

```ts
export const paint = (tone: "page" | "fill") => (tone === "fill" ? "bg-current/15" : "bg-muted")
```

The same fence with no language at all is still a code block, labelled `code`:

```
pnpm build
```

Four spaces of indent is the older way to write one, and it draws the same:

    the indented block
    keeps its own lines

## Tables and rules

A table lines up in columns, and a column can ask to be centred or right-aligned — though the app draws every column left, so the request is a thing you can write and cannot yet see:

| what    |     where     |    when |
| :------ | :-----------: | ------: |
| a cell  |    centred    |   right |
| another | in the middle | aligned |

A rule between two parts of a reply is a hairline, and nothing more:

---

## Pictures

An image written into a reply is drawn in the Gallery's own cell and opens the Previewer on a tap. This one is carried in the reply itself, so it needs no host to be reachable:

![a green plate with a circle and a line of text](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iMTIwIj48cmVjdCB3aWR0aD0iMzIwIiBoZWlnaHQ9IjEyMCIgZmlsbD0iIzJmNmY0ZiIvPjxjaXJjbGUgY3g9IjYwIiBjeT0iNjAiIHI9IjI2IiBmaWxsPSIjZDhmM2UyIi8+PHRleHQgeD0iMTAwIiB5PSI2OCIgZm9udC1mYW1pbHk9InNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTgiIGZpbGw9IiNmZmZmZmYiPmFuIGltYWdlIGluIGEgcmVwbHk8L3RleHQ+PC9zdmc+)

## Footnotes

A claim can carry a note[^1] that lands at the foot of the reply, under a heading a screen reader is given and a reader on screen is not.

[^1]: The note itself, written the way a footnote definition is. One definition anywhere in the reply is also what stops the reply being split into blocks as it streams, which is a fact about the app rather than about markdown.

## Edge cases

These are the ones worth a second look, because they are where the renderer and an author's expectation part company.

#### A fourth level

##### A fifth level

###### A sixth level

The three above are body text with no size or weight of their own: the app styles `h1` to `h3` and leaves the rest to the browser's reset, which takes their size away.

Raw HTML is not drawn. <kbd>Ctrl</kbd> and <mark>this</mark> arrive as the characters a person typed.

Math is not drawn either: $e^{i\pi} + 1 = 0$ stays exactly as written.

An image whose bytes will not decode keeps its cell and says so, rather than leaving a broken icon in the thread:

![a picture that will not decode](data:image/png;base64,zzz)

The boxes in the task list above are the browser's own rather than the app's, and a bullet is still drawn beside each of them.

---

That is every shape a reply can hold, in one page.
