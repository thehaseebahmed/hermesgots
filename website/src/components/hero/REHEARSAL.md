# Rehearsal: Gots hero (GotsHero.tsx)

Gold: `device-pair` for the layout (the window pinned top-left and off the bottom, the phone in
front of it on the right), `messages` and `phone-touch` for the phone's screens, `ai-chat` for the
thread. Built from the app itself: the chat list, the chat, the composer and the answered-question
card were drawn against the app's Storybook screens (`screens--chat-list-laptop`,
`screens--open-chat`, `thread--question-with-choices`), the list row's live states against
`routes/bot-chats.tsx` (a spinner while it works, the warning tone and "Awaiting your answer" while
it waits, an unread dot after), the Bubble against `android/…/BubbleView.kt` (a dark 48dp mark of
five bars, a pill of cancel, level and done, a spinner while the host hears the take).

Beats (about 26s, then the reset):
1. Phone, a plain Android messages app with the keyboard up: the Bubble is tapped, records, the
   tick is tapped, the words land in the field, the text to Sam is sent.
2. A swipe along the gesture bar switches to Gots: a new chat with Nova, its own greeting; the ask
   is typed and sent, Nova is thinking. The laptop's list gains the chat as it is made.
3. The phone locks. Nova's question arrives as a notification with two answers; Apr 15–19 is
   tapped and the notification says Answered. The laptop's row goes from "Awaiting your answer"
   back to working.
4. Home: the phone is put down at the right edge and the laptop comes forward; the row is unread.
5. The cursor opens it: the message from the phone, the answered question, and the interface
   Nova drew (its intro streaming, then three places, then a table of three things to taste).
6. Reset: the phone is picked up and unlocks into the messages app while the laptop slides away;
   what the loop added is cleared while it is out of view and the laptop comes back.

Compact (358 × 640): the phone alone for beats 1–3, then a short laptop window rises over the
top half and the phone is put down across its lower edge; opening the chat pans the window from
the list to the chat pane, which opens on its newest rows (the interface, two places).

Ahead of the app, on purpose (decided with Haseeb 2026-11-15; both must ship by launch or be cut
from the hero):
- Answering a question from the notification. Gots's pushes carry no actions today
  (`app/public/push-sw.js`), and today's question push says only "You have a question waiting".
- Photos in a drawn interface. The interface library has no image component
  (`app/src/components/openui/library.tsx`).

Photos: the three place tiles are drawn stand-ins (CSS gradients, `.gh-photo[data-look]`).
Licensed photos were not fetched: the network check on Wikimedia Commons was refused in the
session that built this. Replace each with a CC0 or public-domain photo (or one we own), kept
under `website/public/hero/`, and record its source and licence here.

Captured: in the skill's preview at 1280, 390 and dark (`rehearsal passed` on each), and on the
built site at 1280 and 390, light and dark.

Gate on the built site: six `kit override` lines, which stand: film-checks.mjs decides a sheet is
the kit's by its path containing `/kit/`, and Astro bundles the kit's CSS into `/_astro/*.css`,
so the kit's own phone rules read as the example's. No rule in `gots.css` touches a kit part's
geometry (it sets the keyboard's colour tokens and its sheet's corners only).
Also stands: `near-empty frames` at 390 around the lock screen, which is a phone alone on the
stage by design; it is not a gating line.

Assumptions: Nova is the bot (The Explorer), its greeting is one of its own lines
(`app/src/components/bots.tsx`); the phone is Android because the Bubble is Android-only; the
app's icon is `app/public/pwa-192x192.png` (served as `/app-icon.png`); the messages app and its
contact (Sam) are generic and wear no one's brand.
Unresolved: the loop is about 30s, twice the skill's 10 to 16; the story has two devices and a
commute, and every beat was kept by choice.
Not checked: Safari and Firefox; a slow network's first paint; a fresh-eye review by a second
reviewer.
