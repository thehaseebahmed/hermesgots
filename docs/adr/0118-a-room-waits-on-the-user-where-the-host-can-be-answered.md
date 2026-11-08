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
the app's runs — never sees it. What the Host does project is the turn's activity on
`on_room_member_activity`; a Host that projects the clarify prompt as its own frame names the server
request the turn blocks on, and the plugin keeps the words, the choices and who asked until the user
answers. The answer is written back as a response frame on that request, through the Host's own
`server_requests.resolve_response`, so the member's turn carries on in the same run with the answer
the user picked. `rooms_questions` is advertised apart from `rooms`, only where the Host declares
`room_member_questions`: where that pairing can't be made — an older Host that never projects a
question — nothing is held, no card is drawn, and the Host's own clarify timeout answers. That is
the plan's own risk made visible rather than papered over.

**Stop is `groups.stop`, and the log is what says so.** Cancelling the room's work is one call with
the app's `cancel_id`; what the user reads afterwards is the Host's own rows — `room.stop_requested`
and `turn.cancelled` — folded into the transcript's notices. The plugin writes nothing of the
transcript itself: a room's words are the Host's.

**`@user` is a reading, not a call.** The Host settles a round when no peer is cited, so calling Stop
on top of an escalation would race the settle and could cancel an unrelated live task. `askingMember`
reads the newest message row instead: a member's reply mentioning `@user` (on a word boundary, so
`@usernames` is somebody's name) asks, and the user's next message or a member's later reply clears
it. The screen draws the mark beside the cards, never in place of one.

**Departure from the plan's wording.** The plan said a question "goes through the plugin's own
holding for that member's run" without naming how a plan-side Host would fill it. The Host as it
stands projects approvals only, so the plugin advertises `rooms_questions` solely where a Host
declares it projects questions and the plugin can resolve one. On today's Host that row is absent,
and the question card is exercised against the test host; the plugin's half is proven by
`test_rooms`, and the app's card by `test-room-waiting.tsx` and `pnpm e2e room-waiting`.
