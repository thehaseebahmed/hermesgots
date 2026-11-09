# The app mints a seat's id and derives its handle

Making a room means naming its members to the Host: a row per seat, keyed by an id and addressed by a
handle. The Host validates both — two to six seats, unique handles, and `@all`/`@everyone` reserved — but
declares no method that allocates either, so somebody has to choose them before the call.

**So the app mints each seat's member id**, one per picked bot, stable for the sheet's life, and **derives
the handle from the bot's profile name**. A profile name is already unique on its Host — it is the key the
room's answering bot and its member pictures are resolved by (ADR 0115) — so the app owns no naming rule
the Host would have to repeat, and the Host's refusal stays the authority on uniqueness and on the
reserved words.

**What follows, and is accepted.** A handle that collides with a reserved word, or with a rule the Host
keeps that the app cannot see, can only be refused: the sheet shows the Host's words, and the user changes
the bot's profile name to get past it. The alternative — a handle field in the sheet — would make the user
name each member twice and let two rooms disagree about what a bot is called. And because a roster cannot
change after creation, a wrong handle means a new room.
