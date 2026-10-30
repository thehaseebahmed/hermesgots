"""The prompts doc is what the generator writes, checked where every pull request runs.

`docs/prompts.md` is a build artefact of the prompt modules, but the workflow that regenerates it runs
on `main` and only when one of those modules changes — so a module whose shape moves breaks the
workflow where no branch's own gates look. That is what happened when the dictation cleanup's bounds
moved into `LEVEL_FACTS`: the generator still read a `SHORTER` table that no longer existed, the
workflow failed instead of opening its pull request, and nothing else noticed. The same comparison,
run with the plugin's own tests, fails on the branch that moved the module.

Run: python3 -m unittest plugin.tests.test_prompts_doc -v
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "plugin" / "scripts" / "generate_prompts_doc.py"
DOC = ROOT / "docs" / "prompts.md"


def _generator() -> ModuleType:
    """The generator as a module, loaded by path: it is a script, not an importable module."""
    spec = importlib.util.spec_from_file_location("generate_prompts_doc", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PromptsDocTest(unittest.TestCase):
    def test_the_doc_is_what_the_generator_writes(self):
        self.assertEqual(_generator().build(), DOC.read_text(encoding="utf-8"))

    def test_a_section_for_every_level_that_calls_a_model(self):
        # `none` makes no call, so it has no section: the three that do are the levels below it.
        module = _generator()
        calling = [level for level in module.dictation_cleanup.LEVELS if level != module.dictation_cleanup.NONE]
        titles = [title for title, _note, _text in module.DICTATION_VARIANTS]
        self.assertEqual(titles[: len(calling)], [f"Dictation cleanup: {level}" for level in calling])
        self.assertEqual(titles[-1], "Dictation: the speech model's prompt")


if __name__ == "__main__":
    unittest.main()
