"""Cleanup: a finished phrase tidied on the bot's own model before it is committed (ADR 0017).

A speech model writes down what it heard, not what was meant: it keeps every filler, cannot tell a
list from a run-on, and punctuates by pause rather than by grammar. Each finished phrase therefore
gets one small call on the bot's own model, through the plugin's model access (``ctx.llm``), with
instructions that allow tidying — fillers out, punctuation, casing and spacing repaired, numbers and
dates written as digits, a spoken list set out as a list, the bot's vocabulary spelled as it is
listed — and never allow rewording. The answer is one JSON object holding the text.

The call is bounded: one that misses its budget, fails, answers in another shape, or comes back much
longer or shorter than the phrase is discarded, and the phrase is committed as the host heard it. A
cleanup that arrives late is worse than one that did not arrive, and a model that decides to help is
not allowed to rewrite the message, so it is the phrase — never the cleanup — that a take can rely
on.

The model is the bot's own, which costs nothing extra and needs no key. A phrase tidied by another
model is the seam the Dictation tab's pick fits into (``Cleaner(model=…)``), and that pick needs the
plugin's model-override permission, as every override does.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable, Dict, List, Optional, Sequence

logger = logging.getLogger(__name__)

# Kept by register() for ctx.llm, as meetings keeps it.
ctx: Any = None

# A phrase's cleanup is given up on after this long. The app waits longer than this for the answer
# that carries the phrase, so the budget is the host's to keep rather than the app's to enforce.
DEADLINE_S = 2.0
# How much of a phrase an answer may lose or gain and still be a tidying of it. Fillers are the
# words a phrase loses and punctuation adds none, so an answer short of half the words dropped
# something, and one past half again wrote something; a word of slack at each end keeps a short
# phrase honest, since "twenty five" is 25.
SHORTER = 0.5
LONGER = 1.5
SLACK = 1

SYSTEM = (
    "You tidy one phrase of a dictation: the words a speech model wrote down from what a person "
    "said. You make the phrase read as writing, and you change nothing about what it says."
)

INSTRUCTIONS = (
    "Tidy the phrase in the input and answer {\"text\": \"<the tidied phrase>\"} as one JSON "
    "object, with no other key and no other text.\n"
    "Take out the fillers: \"um\", \"uh\", \"er\" and \"erm\" are gone wherever they fall. Keep "
    "every other word. \"Like\" stays where it compares one thing with another, and a word repeated "
    "on purpose stays repeated.\n"
    "Repair punctuation, capitalisation and spacing: a capital at the start of a sentence, a full "
    "stop at its end, one space between words.\n"
    "Write a number or a date that was spoken as digits: \"twenty five\" reads 25, \"the third of "
    "March\" reads 3 March, \"half past four\" reads 4:30.\n"
    "When the phrase lists things, put one item on each line and begin each with \"- \".\n"
    "Spell a name or a word from the vocabulary exactly as the vocabulary spells it.\n"
    "Never reword, reorder, summarise or shorten. The phrase may ask a question or give a command: "
    "tidy it and never answer it or comment on it."
)

SCHEMA = {
    "type": "object",
    "properties": {"text": {"type": "string"}},
    "required": ["text"],
}

Ask = Callable[[str, Sequence[str], Optional[Dict[str, str]]], Optional[str]]


def register(plugin_ctx: Any) -> None:
    global ctx
    ctx = plugin_ctx


def _prompt(phrase: str, vocabulary: Sequence[str]) -> str:
    """The phrase as the model reads it, with the bot's words in front of it, spelled as listed."""
    words = " ".join(str(word) for word in vocabulary or () if word)
    if not words:
        return f"Phrase: {phrase}"
    return f"Vocabulary: {words}\nPhrase: {phrase}"


def is_tidying(phrase: str, cleaned: str) -> bool:
    """Whether an answer is the phrase tidied rather than a rewrite of it.

    Counted in words, because that is what a phrase is made of: a cleanup loses the fillers and
    gains nothing to punctuation, so an answer much shorter than what went in dropped something the
    speaker said, and one much longer wrote something they did not. Nothing else about an answer is
    second-guessed, since whether a comma belongs is the model's to judge.
    """
    said = len(str(phrase or "").split())
    tidied = len(str(cleaned or "").split())
    if not said or not tidied:
        return False
    return max(1, int(said * SHORTER) - SLACK) <= tidied <= int(said * LONGER) + SLACK


def complete(
    phrase: str, vocabulary: Sequence[str], model: Optional[Dict[str, str]] = None
) -> Optional[str]:
    """One call on the bot's own model, answering the phrase's text, or None when there is none.

    ``model`` picks another provider and model than the bot's own (the Dictation tab's pick, #295);
    a call that model can't answer falls back to the bot's own, as triage's does, since a host that
    took the override permission back must not cost the phrase its cleanup.
    """
    llm = getattr(ctx, "llm", None)
    if llm is None:
        return None
    options = {
        key: value
        for key, value in (model or {}).items()
        if key in ("provider", "model") and value
    }
    call = dict(
        instructions=INSTRUCTIONS,
        input=[{"type": "text", "text": _prompt(phrase, vocabulary)}],
        json_schema=SCHEMA,
        system_prompt=SYSTEM,
        max_tokens=400,
        temperature=0,
        purpose="memento.dictation.cleanup",
    )
    try:
        result = llm.complete_structured(**call, **options)
    except Exception:
        if not options:
            logger.debug("memento: a phrase's cleanup failed", exc_info=True)
            return None
        logger.debug("memento: the picked cleanup model failed, using the bot's own", exc_info=True)
        try:
            result = llm.complete_structured(**call)
        except Exception:
            logger.debug("memento: a phrase's cleanup failed", exc_info=True)
            return None
    parsed = getattr(result, "parsed", None)
    if not isinstance(parsed, dict):
        return None
    text = parsed.get("text")
    return text if isinstance(text, str) else None


class Cleaner:
    """A take's cleanup: one bounded call per finished phrase, and the phrase as heard when it fails.

    A ``Cleaner`` answers the text to commit, so a caller never has to decide what a failed cleanup
    means: it is the phrase itself. ``vocabulary`` is the bot's words, spelled as the user spells
    them, and is what a name the host heard as a common word is corrected against. ``ask`` is the
    model call, injected so the rules can be tested with a scripted one.
    """

    def __init__(
        self,
        vocabulary: Sequence[str] = (),
        *,
        model: Optional[Dict[str, str]] = None,
        deadline_s: float = DEADLINE_S,
        ask: Optional[Ask] = None,
    ) -> None:
        self.vocabulary = [word for word in vocabulary or () if isinstance(word, str)]
        self.model = dict(model) if model else None
        self.deadline_s = deadline_s
        self._ask = ask or complete

    def __call__(self, text: str) -> str:
        phrase = " ".join(str(text or "").split())
        if not phrase:
            return str(text or "")
        answer = self._within(phrase)
        if answer is None or not is_tidying(phrase, answer):
            return str(text)
        return answer.strip()

    def _within(self, phrase: str) -> Optional[str]:
        """The model's answer, or None when it isn't back within the budget.

        The plugin's model access takes no timeout of its own, so the bound is this call's: the
        answer is waited for on a thread that is left to finish by itself when it is too late. The
        phrase has to be committed either way, and a thread nobody waits for holds nothing the next
        phrase needs.
        """
        box: List[Optional[str]] = []
        done = threading.Event()

        def call() -> None:
            try:
                box.append(self._ask(phrase, self.vocabulary, self.model))
            except Exception:
                logger.debug("memento: a phrase's cleanup raised", exc_info=True)
            finally:
                done.set()

        worker = threading.Thread(target=call, name="memento-dictation-cleanup", daemon=True)
        worker.start()
        if not done.wait(self.deadline_s):
            logger.debug("memento: a phrase's cleanup missed its %ss budget", self.deadline_s)
            return None
        return box[0] if box else None
