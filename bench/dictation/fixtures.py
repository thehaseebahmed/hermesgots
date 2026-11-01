"""The audio a run hears, its reference transcript, and the hash that says which bytes were heard.

A fixture is chosen by what can go wrong rather than by count (ADR 0075): one Piece, a sentence that
straddles a pause, a long unbroken take, room tone, names against a Vocabulary, speech over a floor
above the app's quiet threshold, a take for the cloud path, and a minute of speech in several Pieces,
with one take in the app's own container beside them. ``fixtures/manifest.json`` names each one, what
it is for, and which route hears it.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from . import FIXTURES

# Which route hears a take: the host decodes it Piece by Piece, or holds it whole for a provider.
LOCAL_ROUTE = "local"
CLOUD_ROUTE = "cloud"


@dataclass(frozen=True)
class Fixture:
    """One recording, the words it says, and how the app would send it."""

    name: str
    audio: Path
    content_type: str
    reference: str
    why: str = ""
    route: str = LOCAL_ROUTE
    vocabulary: Sequence[str] = field(default_factory=tuple)
    hint: str = ""

    def hash(self) -> str:
        return hashlib.sha256(self.audio.read_bytes()).hexdigest()


def load(only: Sequence[str] = ()) -> List[Fixture]:
    """Every fixture the manifest names, in its order, or the ones ``only`` asks for."""
    manifest = json.loads((FIXTURES / "manifest.json").read_text())
    fixtures = []
    for entry in manifest["takes"]:
        fixtures.append(
            Fixture(
                name=entry["name"],
                audio=FIXTURES / entry["file"],
                content_type=entry["type"],
                reference=(FIXTURES / entry["reference"]).read_text().strip(),
                why=entry.get("why", ""),
                route=entry.get("path", LOCAL_ROUTE),
                vocabulary=tuple(entry.get("vocabulary") or ()),
                hint=entry.get("hint", ""),
            )
        )
    if only:
        known = {fixture.name for fixture in fixtures}
        unknown = [name for name in only if name not in known]
        if unknown:
            raise ValueError(f"no fixture called {', '.join(unknown)}: {', '.join(sorted(known))}")
        fixtures = [fixture for fixture in fixtures if fixture.name in set(only)]
    return fixtures


def digest(fixtures: Sequence[Fixture]) -> Dict[str, Any]:
    """The fixture set, as a run records it: its hash, its files, and each file's own hash."""
    ordered = sorted(fixtures, key=lambda fixture: fixture.name)
    whole = hashlib.sha256()
    files = []
    for fixture in ordered:
        one = fixture.hash()
        whole.update(f"{fixture.name}\0{one}\n".encode())
        files.append({"name": fixture.name, "file": fixture.audio.name, "sha256": one})
    return {"sha256": whole.hexdigest(), "count": len(ordered), "files": files}
