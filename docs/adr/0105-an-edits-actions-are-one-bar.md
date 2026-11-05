# An edit's actions are one bar at the foot of its form

Every edit form had its own footer: a Cancel and a Save stacked on a phone and pushed to the right on
anything wider, in the buttons' default weight, directly under the field. Which form you were in
changed where its actions were and how much they weighed, and on a phone the two sat close enough to
the field to read as part of it — the same weakness ADR 0055 set out to fix in the rows themselves.

**One bar, two answers.** An edit's actions are a single pill, centred under the form, holding the
two things the screen can do: _Cancel_ and _Save_, or — where the form can clear its key back to the
host's default — _Reset_ and _Save_. A third segment for the reset made the bar ask what the leaving
already answers: going back is Cancel, and always was, so the pill holds the write and the one other
thing the screen itself offers. Both actions sit in the same pill and the same type, and the writing one carries the weight
(_Save_ medium, the reset plain): the choice a form asks for is between writing and not writing, not
between two kinds of button.

**Only a pushed screen asks before it discards.** Going back without Save is Cancel, not a loss, and
a form nobody typed in leaves at once. Where something *was* typed and the form is the screen — a
phone, where the form fills it — the back asks first, because a filled field one gesture from the
page is a slip waiting to happen. Where the edit is a card over the page it asks nothing: closing a
pop-up is the whole of saying no, and a confirmation over one is a dialog about a dialog.

**The field is a field, not a box in a list.** The label sits above it in the muted tone the value
rows use, and the input is a filled, fully rounded field a thumb can find. On a phone the form fills
the screen so the bar stands at its foot, where a thumb already is; drawn as a centred card above
1024px, the bar stops under the field.

**Why the shape is borrowed rather than invented.** Samsung's own account editors put the pair in a
pill at the bottom of a pushed form, and every text edit in this app is a pushed form on a phone. The
bar also settles a question the button row left open: a switch on the same screen acts as it is
touched while an edit waits for Save, and a form whose actions are visibly _its own_ reads as the
form's commit rather than as the page's — the distinction GitHub's Primer draws when it says a page
should not mix saving patterns (the page ADR 0104's neighbours keep switches immediate all the same, as
ADR 0055 requires).

Every edit form wears it: the settings edit (`EditForm`) and the per-setting forms the speech page
opens. A form that is not an edit — a wizard step, a create sheet with one action — is not a bar with
two segments and keeps the action it has.
