"""Carrying a host over from the plugin's old name (memento) to Gots.

The move must lose nothing: the data lands under the new name with the same rows, a copy of the
database and a link under the old name are left behind, and a database another process is using
stops the move instead of splitting the data. The config step moves the plugin's name in
``config.yaml`` without turning the new plugin off.

Run: python3 -m unittest plugin.tests.test_migrate -v
"""

from __future__ import annotations

import sqlite3
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from plugin import migrate, paths
from plugin.store import connect, db_path


def seed(home: Path, chats: int = 3) -> Path:
    """An old host: ``memento/memento.db`` with some rows, a link and an attachment."""
    old = home / "memento"
    (old / "attachments" / "s1").mkdir(parents=True)
    (old / "attachments" / "s1" / "photo.png").write_bytes(b"png")
    (old / "link.json").write_text('{"token": "mh_secret"}', encoding="utf-8")
    conn = connect(old / "memento.db")
    try:
        for index in range(chats):
            conn.execute(
                "INSERT INTO chats (id, at, deleted, value) VALUES (?, ?, 0, ?)", (f"c{index}", index, "{}")
            )
    finally:
        conn.close()
    return old / "memento.db"


def rows(path: Path) -> int:
    with sqlite3.connect(path) as conn:
        return conn.execute("SELECT COUNT(*) FROM chats").fetchone()[0]


class MoveDataTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        paths._retry_at.clear()

    def test_moves_the_folder_and_keeps_every_row(self) -> None:
        seed(self.home, chats=3)
        outcome = migrate.move_data(self.home)
        self.assertEqual(outcome.status, "moved", outcome.detail)
        self.assertEqual(rows(self.home / "gots" / "gots.db"), 3)
        self.assertEqual((self.home / "gots" / "link.json").read_text(encoding="utf-8"), '{"token": "mh_secret"}')
        self.assertEqual((self.home / "gots" / "attachments" / "s1" / "photo.png").read_bytes(), b"png")

    def test_leaves_a_copy_of_the_database_and_a_link_under_the_old_name(self) -> None:
        seed(self.home, chats=2)
        migrate.move_data(self.home)
        self.assertEqual(rows(self.home / "gots" / migrate.BACKUP), 2)
        old = self.home / "memento"
        self.assertTrue(old.is_symlink())
        # A path an agent wrote down before the move still opens.
        self.assertEqual((old / "attachments" / "s1" / "photo.png").read_bytes(), b"png")

    def test_a_database_in_use_stops_the_move(self) -> None:
        db = seed(self.home)
        other = sqlite3.connect(db, isolation_level=None)
        self.addCleanup(other.close)
        other.execute("BEGIN IMMEDIATE")
        outcome = migrate.move_data(self.home)
        self.assertEqual(outcome.status, "busy")
        self.assertTrue(db.exists())
        self.assertFalse((self.home / "gots").exists())

    def test_nothing_to_move_on_a_fresh_host_or_an_already_moved_one(self) -> None:
        self.assertEqual(migrate.move_data(self.home).status, "none")
        seed(self.home)
        self.assertEqual(migrate.move_data(self.home).status, "moved")
        self.assertEqual(migrate.move_data(self.home).status, "none")

    def test_a_folder_without_a_database_still_moves(self) -> None:
        old = self.home / "memento"
        old.mkdir()
        (old / "link.json").write_text("{}", encoding="utf-8")
        self.assertEqual(migrate.move_data(self.home).status, "moved")
        self.assertTrue((self.home / "gots" / "link.json").exists())


class DataDirTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        paths._retry_at.clear()

    def test_a_fresh_host_gets_the_new_names(self) -> None:
        self.assertEqual(db_path(self.home), self.home / "gots" / "gots.db")

    def test_the_first_read_moves_an_old_host_over(self) -> None:
        seed(self.home, chats=4)
        path = db_path(self.home)
        self.assertEqual(path, self.home / "gots" / "gots.db")
        self.assertEqual(rows(path), 4)

    def test_while_the_old_database_is_in_use_the_old_folder_is_used(self) -> None:
        db = seed(self.home)
        other = sqlite3.connect(db, isolation_level=None)
        self.addCleanup(other.close)
        other.execute("BEGIN IMMEDIATE")
        self.assertEqual(db_path(self.home), self.home / "memento" / "memento.db")
        # Not asked again on every call.
        with mock.patch.object(migrate, "move_data") as move:
            db_path(self.home)
            move.assert_not_called()
        other.rollback()
        paths._retry_at.clear()
        self.assertEqual(db_path(self.home), self.home / "gots" / "gots.db")


def fake_hermes(config: dict):
    """``gateway.run`` and ``utils`` stand-ins: the config is a dict and a write sets a dotted path."""

    def load(config_path=None):
        return config

    def write(path, key, value):
        node = config
        parts = key.split(".")
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        if value is None:
            node.pop(parts[-1], None)
        else:
            node[parts[-1]] = value

    run = types.ModuleType("gateway.run")
    run._load_gateway_config = load
    utils = types.ModuleType("utils")
    utils.atomic_roundtrip_yaml_update = write
    return mock.patch.dict(
        sys.modules, {"gateway": types.ModuleType("gateway"), "gateway.run": run, "utils": utils}
    )


class MigrateConfigTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "config.yaml"
        self.path.write_text("plugins: {}\n", encoding="utf-8")

    def run_with(self, config: dict, apply: bool = True):
        with fake_hermes(config):
            return migrate.migrate_config(self.path, apply=apply)

    def test_enabled_swaps_the_name_and_keeps_the_rest(self) -> None:
        config = {"plugins": {"enabled": ["disk-cleanup", "memento"]}}
        self.run_with(config)
        self.assertEqual(config["plugins"]["enabled"], ["disk-cleanup", "gots"])

    def test_enabled_does_not_list_gots_twice(self) -> None:
        config = {"plugins": {"enabled": ["gots", "memento"]}}
        self.run_with(config)
        self.assertEqual(config["plugins"]["enabled"], ["gots"])

    def test_disabled_forgets_the_old_name_instead_of_renaming_it(self) -> None:
        # `hermes plugins disable memento` parked it there; renaming it would turn Gots off.
        config = {"plugins": {"enabled": ["gots"], "disabled": ["memento", "other"]}}
        self.run_with(config)
        self.assertEqual(config["plugins"]["disabled"], ["other"])
        self.assertEqual(config["plugins"]["enabled"], ["gots"])

    def test_disabled_is_removed_when_it_would_be_empty(self) -> None:
        config = {"plugins": {"disabled": ["memento"]}}
        self.run_with(config)
        self.assertNotIn("disabled", config["plugins"])

    def test_the_grants_move_and_the_new_ones_win(self) -> None:
        config = {
            "plugins": {
                "entries": {
                    "memento": {"llm": {"allow_model_override": True, "allow_provider_override": True}},
                    "gots": {"llm": {"allow_provider_override": False}},
                }
            }
        }
        self.run_with(config)
        entries = config["plugins"]["entries"]
        self.assertNotIn("memento", entries)
        self.assertEqual(entries["gots"], {"llm": {"allow_model_override": True, "allow_provider_override": False}})

    def test_a_dry_run_changes_nothing_and_says_what_would(self) -> None:
        config = {"plugins": {"enabled": ["memento"], "entries": {"memento": {"a": 1}}}}
        changes = self.run_with(config, apply=False)
        self.assertEqual(len(changes), 2)
        self.assertEqual(config["plugins"]["enabled"], ["memento"])
        self.assertIn("memento", config["plugins"]["entries"])

    def test_nothing_to_do_on_a_new_host(self) -> None:
        config = {"plugins": {"enabled": ["gots"]}}
        self.assertEqual(self.run_with(config), [])

    def test_no_config_file_is_nothing_to_do(self) -> None:
        self.path.unlink()
        self.assertEqual(self.run_with({}), [])


if __name__ == "__main__":
    unittest.main()
