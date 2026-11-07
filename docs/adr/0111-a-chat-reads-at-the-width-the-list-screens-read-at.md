# A chat reads at the width the list screens read at

A chat's text was 736px inside a 768px box (ADR 0047), while every list screen — Code, Research,
Routines, Meetings and the apps — centres `max-w-2xl`: a 672px box with its own 16px gutters
inside it. So moving between a chat and Code changed the measure by 64px for no reason a reader
could name. The reading column is now **640px of text in the 672px box**, which is the lists' box
exactly: a chat's cards and a list's rows stop on the same pixels, and the words inside them land
within 2px of each other (640 against the lists' 640).

**Considered options.** Leaving it (the shift is what a reader noticed); widening the lists to 736
(five screens re-laid out to match two, and their rows are built for 672); keeping the 736 box and
setting only its text to 672 (the box and the text would then carry 32px gutters each side rather
than 16, which breaks the rule that a card frames its text exactly).

**Consequences.** Every chat's text narrows by 96px and its cards cap at 672 instead of 768, so a
wide table or a long code line in a reply wraps sooner than it did. ADR 0047's rule — a card fills
its container and stops at the box, never past it — is unchanged, and its numbers are amended. The
card-widths flow measures the new frame at 390, 1024 and 1440px.
