"""What a notification says, and what it is: the one value every transport carries, and the one table
the kinds are read from.

A notice is what happened and what it happened in — its title (the chat's, the routine's or the
project's name), its body, the bot whose picture it wears, and the buttons a press may post — so a
push and an ntfy publish both carry one value, and neither words anything of its own.

The kinds are one table here, where the plugin kept them in pieces: what a kind is about, the switch
that silences it, the sentence it says and what a title falls back to when nothing named it.
"""

from __future__ import annotations

from typing import Dict, Iterable, NamedTuple, Optional, Tuple


class Action(NamedTuple):
    """A button a notice carries: what it says, and the link a press posts to."""

    label: str
    url: str


class Notice(dict):
    """A notification's payload: the fields a push carries beside its kind and its session.

    The notice *is* that mapping, so a transport spreads it onto its own payload unchanged rather than
    picking fields out of it, and a field with no value is left out rather than sent empty — a device
    reads a missing title as ``Gots``. ``actions`` are the buttons a tray may draw, which no payload
    carries: a press posts a link of its own.
    """

    def __init__(
        self,
        title: Optional[str] = None,
        body: Optional[str] = None,
        bot: Optional[str] = None,
        actions: Iterable[Action] = (),
    ) -> None:
        super().__init__(
            {key: value for key, value in (("title", title), ("body", body), ("bot", bot)) if value}
        )
        self.actions: Tuple[Action, ...] = tuple(actions)

    @property
    def title(self) -> Optional[str]:
        return self.get("title")

    @property
    def body(self) -> Optional[str]:
        return self.get("body")

    @property
    def bot(self) -> Optional[str]:
        return self.get("bot")


class Kind(NamedTuple):
    """One kind of news: what it is about, what it says, and which switch silences it."""

    name: str
    # The category of the session it is about, when that session is a chat's.
    category: str
    # The category when that session is a project's, where it differs from the chat's.
    code: Optional[str]
    # What happened.
    words: str
    # What it is about, when nothing named it.
    untitled: Optional[str] = None
    # About a chat's session, so that chat's mute silences it too.
    session: bool = False
    # It waits on the user.
    waits: bool = False


# What a push is about. `approval`, `question`, `plan` and `room_input` wait on the user; the rest
# are news. The registry (`app/netlify/lib/fcm.ts`) and the app (`app/src/lib/push-kinds.ts`) keep
# the same lists.
KINDS_TABLE: Tuple[Kind, ...] = (
    Kind("approval", "chat_input", "code_input", "Waiting for your approval", session=True, waits=True),
    Kind("question", "chat_input", "code_input", "You have a question waiting", session=True, waits=True),
    Kind("plan", "code_input", None, "The plan is ready for your review", session=True, waits=True),
    Kind("run_done", "chat_run_done", "code_run_done", "You have a new reply", session=True),
    Kind("run_failed", "chat_run_failed", "code_run_failed", "The run stopped with an error", session=True),
    Kind("clone_failed", "code_setup_failed", None, "This project couldn't be set up", "A project"),
    Kind("routine_failed", "routine_failed", None, "The last run failed", "A routine"),
    Kind("research_brief", "research_input", None, "The brief is ready for your review", "A research mission"),
    Kind("research_scope", "research_input", None, "The scope is ready for your approval", "A research mission"),
    Kind("research_done", "research_done", None, "Your research is ready", "A research mission"),
    Kind("research_failed", "research_failed", None, "The mission stopped with an error", "A research mission"),
    Kind("routine_message", "routine_message", None, "A bot has a message", "A bot", session=True),
    Kind("meeting_done", "meeting_done", None, "Your meeting notes are ready", "A meeting"),
    Kind("meeting_failed", "meeting_failed", None, "Meeting notes failed", "A meeting"),
    # A room of this Host's bots waits on the user, and it is its own kind because a room is
    # nobody's chat: a push about one names the room, not a session.
    Kind("room_input", "room_input", None, "A room is waiting on you", "A room"),
)

KINDS: Tuple[str, ...] = tuple(kind.name for kind in KINDS_TABLE)
KINDS_BY_NAME: Dict[str, Kind] = {kind.name: kind for kind in KINDS_TABLE}
# Kinds that are about a chat's session, so that chat can be muted. A routine's answer lands in a
# chat's own session too, so that chat's mute silences it.
SESSION_KINDS: Tuple[str, ...] = tuple(kind.name for kind in KINDS_TABLE if kind.session)
INPUT_KINDS: Tuple[str, ...] = tuple(kind.name for kind in KINDS_TABLE if kind.waits)

# What a device switches: a kind within a feature (chats, code, routines, research). A session's
# kinds belong to Code when it is a project session, else to Chats; a room's is the room's own,
# whichever feature its session would have been in. This is the order the app lists them in
# (`app/src/lib/push-kinds.ts`, `PUSH_CATEGORIES` in `app/netlify/lib/fcm.ts`).
CATEGORIES: Tuple[str, ...] = (
    "chat_input",
    "chat_run_failed",
    "chat_run_done",
    "room_input",
    "code_input",
    "code_run_failed",
    "code_run_done",
    "code_setup_failed",
    "routine_failed",
    "routine_message",
    "research_input",
    "research_done",
    "research_failed",
    "meeting_done",
    "meeting_failed",
)
# What a device that never said which it wants gets: what pushed before there were more.
LEGACY_CATEGORIES: Tuple[str, ...] = ("chat_input", "code_input")

# What happened, under the title of what it happened in. `app/netlify/lib/fcm.ts` and
# `app/public/push-sw.js` say the same; `tests/test_ntfy.py` fails when these drift from them.
WORDS: Dict[str, str] = {kind.name: kind.words for kind in KINDS_TABLE}
# When nothing names what the news is about, in the order the registry lists them (`UNTITLED` in
# `app/netlify/lib/fcm.ts`), which groups them by feature rather than by kind.
UNTITLED: Dict[str, Optional[str]] = {
    name: KINDS_BY_NAME[name].untitled
    for name in (
        "routine_failed", "routine_message", "clone_failed", "research_brief", "research_scope",
        "research_done", "research_failed", "meeting_done", "meeting_failed", "room_input",
    )
}


def category_of(kind: str, project: bool = False) -> str:
    """The category a kind lands in: a session's kinds belong to the feature its session is in, and
    whatever else a kind is about has a category of its own."""
    row = KINDS_BY_NAME[kind]
    return (row.code or row.category) if project else row.category
