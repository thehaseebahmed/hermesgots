"""What a take landed, against what it should have: the words, and how far apart they are.

A decoder writes punctuation and capitals a reference transcript need not carry, so both sides are
folded to their words before anything is compared — lowercased, split on anything that isn't a word,
with an apostrophe kept inside one. The distance is word error rate, ``(substitutions + deletions +
insertions) / reference words``, which is the one figure a reader can hold and a diff can show.
"""

from __future__ import annotations

import re
from typing import Dict, List, Sequence

_WORD = re.compile(r"[^\W_]+(?:'[^\W_]+)?")


def words_of(text: str) -> List[str]:
    """The words of ``text``, folded: lower case, punctuation dropped, one per entry."""
    return _WORD.findall((text or "").lower().replace("’", "'"))


def distance(reference: Sequence[str], heard: Sequence[str]) -> int:
    """How many substitutions, deletions and insertions turn ``reference`` into ``heard``."""
    if not reference:
        return len(heard)
    previous = list(range(len(heard) + 1))
    for row, expected in enumerate(reference, start=1):
        current = [row]
        for column, actual in enumerate(heard, start=1):
            cost = 0 if expected == actual else 1
            current.append(
                min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost)
            )
        previous = current
    return previous[-1]


def wer(reference: str, heard: str) -> float:
    """``heard``'s distance from ``reference``, in words: 0 is every word in its place."""
    expected = words_of(reference)
    said = words_of(heard)
    if not expected:
        # Nothing was said, so there is nothing to be wrong about: a word where none belongs shows
        # up as the count itself rather than as a rate with no denominator.
        return 0.0 if not said else float(len(said))
    return round(distance(expected, said) / len(expected), 3)


def spelled(vocabulary: Sequence[str], heard: str) -> Dict[str, object]:
    """Whether every Vocabulary word came back as it is spelled, and which ones didn't."""
    said = words_of(heard)
    missed: List[str] = []
    for word in vocabulary:
        wanted = words_of(word)
        if not wanted:
            continue
        if not any(said[index : index + len(wanted)] == wanted for index in range(len(said))):
            missed.append(word)
    return {"words": list(vocabulary), "spelled": not missed, "missed": missed}
