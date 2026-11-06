"""The capabilities the plugin declares are exactly what ``register(ctx)`` registers.

Hermes's ``hermes plugins validate`` runs ``register`` against a recording context and fails a
catalog entry whose ``plugin.yaml`` leaves a registered tool, hook or middleware undeclared (the
catalog's rule 6: undeclared capability creep is treated as a security issue). This records the same
three kinds the same way and holds both declarations to them: ``plugin/plugin.yaml``'s top-level
``provides_*`` lists, which the validator reads, and the draft catalog entry's ``capabilities``
block (``docs/catalog/gots.yaml``), which the catalog's own check reads.

Run: python3 -m unittest plugin.tests.test_catalog_capabilities -v
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional

import plugin

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "plugin" / "plugin.yaml"
ENTRY = ROOT / "docs" / "catalog" / "gots.yaml"
KINDS = {"tools": "provides_tools", "hooks": "provides_hooks", "middleware": "provides_middleware"}


class Recording:
    """Hermes's probe context (``RecordingContext`` in ``hermes_cli/plugin_validate.py``): the three
    audited kinds recorded, every other registration accepted and ignored."""

    plugin_config: Dict[str, Any] = {}
    profile_name = "default"
    plugin_id = "gots"

    def __init__(self) -> None:
        self.recorded: Dict[str, List[str]] = {kind: [] for kind in KINDS}

    def register_tool(self, name: str, *args: Any, **kwargs: Any) -> None:
        self.recorded["tools"].append(str(name))

    def register_hook(self, hook_name: str, callback: Any, *, hold_stream: bool = False) -> None:
        self.recorded["hooks"].append(str(hook_name))

    def register_middleware(self, kind: str, callback: Any) -> None:
        self.recorded["middleware"].append(str(kind))

    def get_config(self, key: str, default: Any = None) -> Any:
        return default

    def __getattr__(self, name: str) -> Any:
        if name.startswith("register_"):
            return lambda *args, **kwargs: None
        raise AttributeError(name)


def block_list(text: str, key: str, indent: int = 0) -> Optional[List[str]]:
    """A YAML block or empty-flow list under ``key`` at ``indent``; None when the key is absent.
    Enough for the two files this reads, which keep to that one shape, so the gate needs no YAML
    library."""
    pad = " " * indent
    match = re.search(rf"^{pad}{re.escape(key)}:[ \t]*(\[\])?[ \t]*(#.*)?$", text, re.MULTILINE)
    if not match:
        return None
    if match.group(1):
        return []
    items: List[str] = []
    for line in text[match.end() :].splitlines()[1:]:
        item = re.match(rf"^{pad}  - (\S+)", line)
        if not item:
            break
        items.append(item.group(1))
    return items


class CapabilitiesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        context = Recording()
        plugin.register(context)
        cls.recorded = {kind: sorted(set(names)) for kind, names in context.recorded.items()}

    def test_it_registers_something_to_declare(self) -> None:
        self.assertTrue(self.recorded["tools"], "the probe saw the plugin's tools")
        self.assertTrue(self.recorded["hooks"], "and its hooks")

    def test_plugin_yaml_declares_exactly_what_register_registers(self) -> None:
        text = MANIFEST.read_text(encoding="utf-8")
        for kind, key in KINDS.items():
            declared = sorted(block_list(text, key) or [])
            self.assertEqual(declared, self.recorded[kind], f"plugin.yaml's {key}")

    def test_the_catalog_entry_declares_exactly_what_register_registers(self) -> None:
        text = ENTRY.read_text(encoding="utf-8")
        self.assertIsNotNone(re.search(r"^capabilities:\s*$", text, re.MULTILINE))
        for kind, key in KINDS.items():
            declared = block_list(text, key, indent=2)
            self.assertIsNotNone(declared, f"the entry names {key}, even when empty")
            self.assertEqual(sorted(declared or []), self.recorded[kind], f"the entry's {key}")

    def test_no_env_is_required_to_install(self) -> None:
        """``requires_env`` makes ``hermes plugins install`` ask for each value; every credential
        the plugin can use is optional and read through Hermes's own routes."""
        self.assertEqual(block_list(ENTRY.read_text(encoding="utf-8"), "requires_env", 2), [])
        self.assertIsNone(block_list(MANIFEST.read_text(encoding="utf-8"), "requires_env"))

    def test_the_entry_names_the_plugins_floor_and_version(self) -> None:
        manifest = MANIFEST.read_text(encoding="utf-8")
        entry = ENTRY.read_text(encoding="utf-8")
        floor = re.search(r'^requires_hermes: "(.+)"', manifest, re.MULTILINE)
        version = re.search(r'^version: "(.+)"', manifest, re.MULTILINE)
        assert floor and version
        self.assertIn(f'requires_hermes: "{floor.group(1)}"', entry)
        self.assertIn(f'version: "{version.group(1)}"', entry)
        self.assertRegex(entry, r"(?m)^name: gots$", "the catalog key is the manifest's name")


if __name__ == "__main__":
    unittest.main()
