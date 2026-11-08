# A room waits on the user where the Host can be answered

A room's member can stop and ask: an approval before it runs a command, a question with choices, or
a reply that ends addressed to `@user`. Each one has a different truth on the Host, and the plugin
answers each through the surface the Host actually has rather than inventing a second one.

**An approval is the Host's own pending action, answered through its own approve.** The Host's driver
reports what a member waits on as `driver_status.pending_actions`: the member, the task, the
execution generation and the request id, with the command already redacted. `groups.approve` takes
exactly those four coordinates and resolves that one request, and its `choice` is `once` or `deny`
and nothing else — there is no "allow for this session" in a room. So the card offers two answers,
and a third is refused by the plugin before the Host is asked. The card is drawn only where the Host
declares `groups.approve`: a card whose every tap could come back refused is worse than no card and
the Host's own timeout.

**A question is held by the plugin and answered into the Host's own wait.** A member's turn is a
hidden session on the gateway, not an API-server run, so the plugin's `clarify` tool — which serves
the app's runs — never sees it. The Host's clarify prompt is a server request whose envelope carries
its id and whose params carry the questions; a Host that forwarded both on
`on_room_member_activity` would let the plugin keep the words, the choices and who asked until the
user answers, and the answer is written back as a response frame on that request through the Host's
own `server_requests.resolve_response`, so the member's turn carries on in the same run.

That is a contract, not a guess: the frame must name the request id, and the plugin holds nothing
without it — a card whose tap finds no waiter is worse than no card. It also reads the Host's own
vocabulary (`qid` for a question's id), keeps a held question for half an hour (the Host's clarify
wait gives up after an hour, so a card outliving that can only be refused), and bounds the questions
one room may hold without touching another room's.

`rooms_questions` is advertised apart from `rooms`, only where the Host declares
`room_member_questions`, and the app draws a question card only where that row is on. Where the
pairing can't be made — today's Host projects approvals only, forwards neither a question's kind nor
its request id, and declares no such feature — nothing is held, no card is drawn, and the Host's own
timeout answers. That is the plan's own risk made visible rather than papered over.

**Stop is `groups.stop`, and the log is what says so.** Cancelling the room's work is one call with
the app's `cancel_id`; what the user reads afterwards is the Host's own rows — `room.stop_requested`
and `turn.cancelled` — folded into the transcript's notices. The plugin writes nothing of the
transcript itself: a room's words are the Host's.

**`@user` is a reading, not a call.** The Host settles a round when no peer is cited, so calling Stop
on top of an escalation would race the settle and could cancel an unrelated live task. `askingMember`
reads the newest message row instead: a member's reply mentioning `@user` (on a word boundary, so
`@usernames` is somebody's name) asks, and the user's next message or a member's later reply clears
it. The screen draws the mark where no card already asks, since a card is the user's move drawn in
full and the mark only says what a card can't.

**The wait takes the composer's place, with the chat's own cards.** A room draws a wait exactly as a
chat does: the approval and question cards are the same components the chat's thread uses, carrying
the member's name in their header, and they hold the slot the composer would have. Stop is the
composer's own control, offered while a round runs and the field is empty. The room's composer is the
chat's composer in `plain` mode — no `/` menu and no model pill, because a room's message is an
append and nothing in it runs — and it takes files where the Host has a room attachment store, which
ADR 0119 records; where that row is absent it is words only, as it was here.

**Departure from the plan's wording.** The plan said a question "goes through the plugin's own
holding for that member's run" without naming how a plan-side Host would fill it. The Host as it
stands projects approvals only, so the plugin advertises `rooms_questions` solely where a Host
declares it projects questions and the plugin can resolve one. On today's Host that row is absent,
and the question card is exercised against the test host; the plugin's half is proven by
`test_rooms`, and the app's card by `test-room-waiting.tsx` and `pnpm e2e room-waiting`.
