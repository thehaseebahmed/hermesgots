# The question card stops at half the screen

A bot's question is drawn in place of the composer, and the card had no height of its own: a question
with enough choices — or a long one, or a phone held sideways — grew past the screen, and the card's
own Skip and Send went below the edge with it. The card is the only way to answer, so a question that
outgrew the screen could not be answered at all. A question that arrived on its own had no Skip
either, so nothing but an answer could end it.

**The card takes at most half the screen**, and the question scrolls inside it: the header, the
choices and the footer keep their own heights and only the question between them moves. Half is
enough for five or six choices on a phone, and it leaves the thread the card was asked over in view
— which is what a reader wants when the question is about something they said a moment ago. A card
with one question and a card with five are capped the same way.

**Skip is on every question**, not only on the pages of several: a question is a form the user may
leave blank and submit, which Hermes already names `skipped`, and the second question of a card is no
different from the first in that respect.

**Several questions stay pages of one card, moved by arrows beside their count** — the count at the
header's right, the arrows a thumb's width beside it — as well as by swiping the pages the card
already had. The footer keeps Skip and, from the last page, Send; Next is the footer's own way
forward for a reader who never finds the arrows.

**Every question that came with choices offers an Other**, one only, after the choices the host sent
— even when it sent a single one. The host's list is a suggestion as far as the user is concerned,
and the app has no way to ask again.

## Considered options

- **A full-screen sheet for the question** — rejected: it hides the thread the question is about and
  reads as a different surface from the cards around it, and the answer is usually one tap.
- **Let the page scroll, the card with it** — rejected: the card sits in the composer's slot, outside
  the thread's scroller, so the only thing a page scroll could move is the buttons off the screen
  again.
- **Shrink the choices to fit (smaller rows, one line each)** — rejected: a choice is a sentence the
  user must read to answer, and cutting it to fit is how a card gets answered wrongly.
- **Arrows in the footer beside Skip and Next** — rejected: the footer is where the answer is
  submitted, and a control that only moves between pages reads as one more thing to submit.
- **Skip only where there are several questions** — rejected: the card that outgrows the screen is
  usually the single question, and it was the one with no way out but answering.

## Consequences

- The cap is CSS (`max-h-[50dvh]`) and the paged row's height is measured against it in the browser,
  because a row of pages needs a definite height to scroll a page inside a card that shrank to its
  content. The measurement reads the card's resolved `max-height` and its own header, footer, padding
  and gaps, never the card's current height: a row sized against an already-shrunk card clips the
  page it was sizing.
- A question's text and choices scroll without a scrollbar on a phone, so the row cut at the fold is
  the only signal; the card is drawn over the composer's slot and never over the answer's buttons.
- Height is geometry, which the component tier cannot see (`scripts/test-question-card.tsx` pins the
  cap's class, Skip on every question, the arrows, and Other beside a choice), so the height against
  the screen is measured by `question-card` on the browser sweep at both widths.
- On a host that asks one prompt per question, each question still arrives as its own request, so the
  card holds what one request carries; collecting a run's pending questions into one card is a
  separate decision.
