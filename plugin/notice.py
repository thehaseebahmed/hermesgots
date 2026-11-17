"""What a notification says, and what it is: the one value every transport carries, and the one table
the kinds are read from.

A notice is what happened and what it happened in — its title (the chat's, the routine's or the
project's name), its body, the bot whose picture it wears, and the buttons a press may post — so a
push and an ntfy publish both carry one value, and neither words anything of its own.

The kinds are one table here, where the plugin kept them in pieces: what a kind is about, the switch
that silences it, the sentence it says and what a title falls back to when nothing named it.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, NamedTuple, Optional, Tuple


class Action(NamedTuple):
    """A button a notice carries: what it says, and the link a press posts to."""

    label: str
    url: str


class Notice(dict):
    """A notification's payload: the fields a push carries beside its kind and its session.

    The notice *is* that mapping, so a transport spreads it onto its own payload unchanged rather than
    picking fields out of it, and a field with no value is left out rather than sent empty — a device
    reads a missing title as ``Gots``. ``actions`` are the buttons a tray may draw: they are not in the
    mapping, since a button is not a word, so a transport spreads ``payload()`` instead.
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

    def payload(self) -> Dict[str, Any]:
        """The notice as a transport carries it: its fields, and its buttons where it has any.

        ``actions`` is the one field that is not in the mapping, since a button is the one part of a
        notice that is not a word — so what a transport spreads is this, and a notice with no buttons
        carries no key at all rather than an empty list.
        """
        carried: Dict[str, Any] = dict(self)
        if self.actions:
            carried["actions"] = actions_wire(self.actions)
        return carried


def actions_wire(actions: Iterable[Action]) -> List[Dict[str, str]]:
    """Buttons as the wire carries them: each one's label, and the link a press posts."""
    return [{"label": action.label, "url": action.url} for action in actions]


def carried(notice: Any) -> Dict[str, Any]:
    """What a transport spreads onto its own payload, from a notice or a plain mapping alike.

    A caller that hands a bare dict (a hook that knows only what it was told) carries no buttons,
    which is exactly what a notice without any carries.
    """
    if isinstance(notice, Notice):
        return notice.payload()
    return dict(notice or {})


# What a body carries: the paragraph a reply ends on, on one line. The registry cuts a detail's
# body at this too (`app/netlify/lib/registry.ts`), so a phone that goes through Firebase shows the
# words a browser and ntfy do rather than a second cut of its own.
BODY_MAX = 200


def _cut(text: str, limit: int = BODY_MAX) -> str:
    """Text at a bound, saying it was cut with the same ellipsis a paragraph ends on."""
    return text[: limit - 1].rstrip() + "…" if len(text) > limit else text


def one_line(text: str) -> str:
    """Text as a notice carries it on one line: its runs of whitespace made one space."""
    return " ".join(text.split())


def flatten(text: str, limit: int = BODY_MAX) -> str:
    """Text as a body carries it: one line, then cut at ``limit`` — a body's bound unless a title
    asks for its own."""
    return _cut(one_line(text), limit)


# A run of blank lines in a command: two or more blank lines are one, since a tray has no room for
# air and a heredoc's own shape is what the lines say.
_BLANKS = re.compile(r"\n(?:[ \t]*\n){2,}")


def _command_lines(command: str) -> Optional[str]:
    """A command as a body carries it: every line as it was run, its trailing spaces gone and its
    blank lines one apiece. Never flattened, since a script or a heredoc has to stay readable."""
    lines = [
        line.rstrip() for line in command.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    ]
    return _BLANKS.sub("\n\n", "\n".join(lines)).strip("\n") or None


def approval_body(description: Optional[str], command: Optional[str]) -> Optional[str]:
    """An approval's body, in the shape its card draws it: the description's sentence, then the
    command underneath on its own lines.

    The command stands unlabelled — the hook names no tool, so there is nothing true to label it
    with — with no backticks and no fence, since a tray shows plain text. Nothing said answers
    None, which leaves the kind its own line.
    """
    said = one_line(description) if isinstance(description, str) and description.strip() else None
    script = _command_lines(command) if isinstance(command, str) else None
    parts = [part for part in (said, script) if part]
    return _cut("\n\n".join(parts)) if parts else None


def question_body(question: Optional[str]) -> Optional[str]:
    """A question's body: the question's own words, and only them.

    Not the choices it offers and no button — a question is answered by opening the app, and a
    button is an approval's. A run that asked several says the first, since a tray says one thing.
    """
    return flatten(question) if isinstance(question, str) and question.strip() else None


def paragraph_of(text: Optional[str]) -> Optional[str]:
    """What a reply's notice says: its last paragraph, flattened and cut, or None with no words.

    A reply ends on the words the reader sees last, so that is what tells them the run is done: the
    paragraphs are separated by a blank line, and the one after the last of them is the body. A
    heading over a table, a list of files touched — none of it is the sentence worth a tray, so
    nothing above the last blank line rides. Nothing to say answers None, which leaves the kind its
    own line.
    """
    if not isinstance(text, str):
        return None
    paragraphs = [part for part in re.split(r"\n[ \t]*\n", text) if part.strip()]
    return flatten(paragraphs[-1]) if paragraphs else None


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
# When nothing names what the news is about: the kinds that have a name of their own to fall back to.
# The registry spells the same list in its own order, by feature rather than by kind (`UNTITLED` in
# `app/netlify/lib/fcm.ts`); a kind that gains one here is in it without a second list to edit.
UNTITLED: Dict[str, str] = {
    kind.name: kind.untitled for kind in KINDS_TABLE if kind.untitled
}


def category_of(kind: str, project: bool = False) -> str:
    """The category a kind lands in: a session's kinds belong to the feature its session is in, and
    whatever else a kind is about has a category of its own."""
    row = KINDS_BY_NAME[kind]
    return (row.code or row.category) if project else row.category
