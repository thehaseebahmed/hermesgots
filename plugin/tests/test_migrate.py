"""``hermes gots migrate`` (``migrate.py``): the copy, the config and the gateway guard."""

import os
from contextlib import closing
import sqlite3
import stat
import tempfile
import unittest
from pathlib import Path

from plugin import migrate, store


class MigrateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.old = self.home / "memento"
        (self.old / "attachments" / "memento-a").mkdir(parents=True)
        (self.old / "attachments" / "memento-a" / "x.txt").write_text("hi")
        (self.old / "meetings" / "m1").mkdir(parents=True)
        (self.old / "meetings" / "m1" / "part").write_text("audio")
        (self.old / "link.json").write_text("{}")
        os.chmod(self.old / "link.json", 0o600)
        conn = sqlite3.connect(self.old / "memento.db")
        conn.execute("CREATE TABLE chats (id TEXT, session TEXT)")
        conn.execute("INSERT INTO chats VALUES ('a', 'memento-a')")
        conn.commit()
        conn.close()
        self.config = {
            "plugins": {
                "enabled": ["memento", "other"],
                "entries": {"memento": {"llm": {"allow_model_override": True}}},
            }
        }
        self.saved = []
        self.said = []

    def run_it(self, gateway=lambda: None):
        return migrate.run(
            self.home,
            load=lambda: self.config,
            save=self.saved.append,
            gateway=gateway,
            say=self.said.append,
        )

    def test_the_data_is_copied_into_the_hosts_plugin_data_folder(self):
        self.assertEqual(self.run_it(), 0)
        target = self.home / "plugin-data" / "gots"
        self.assertEqual(store.db_path(self.home), target / "gots.db")
        row = sqlite3.connect(target / "gots.db").execute("SELECT session FROM chats").fetchone()
        self.assertEqual(row, ("memento-a",), "ids are not rewritten: the plugin still reads them")
        self.assertEqual((target / "attachments" / "memento-a" / "x.txt").read_text(), "hi")
        self.assertEqual((target / "meetings" / "m1" / "part").read_text(), "audio")
        self.assertEqual(stat.S_IMODE(os.stat(target / "link.json").st_mode), 0o600)
        self.assertTrue((self.old / "memento.db").exists(), "the old folder is the way back")
        self.assertIn("hermes plugins enable gots", self.said[-1])

    def test_both_plugins_are_disabled_and_the_grants_move(self):
        self.run_it()
        plugins = self.saved[0]["plugins"]
        self.assertEqual(plugins["enabled"], ["other"])
        self.assertEqual(sorted(plugins["disabled"]), ["gots", "memento"])
        self.assertEqual(plugins["entries"], {"gots": {"llm": {"allow_model_override": True}}})

    def test_a_grant_already_under_gots_wins(self):
        self.config["plugins"]["entries"]["gots"] = {"llm": {"allow_model_override": False}}
        self.run_it()
        self.assertEqual(
            self.saved[0]["plugins"]["entries"]["gots"], {"llm": {"allow_model_override": False}}
        )

    def test_a_second_run_changes_nothing(self):
        self.run_it()
        db = store.db_path(self.home)
        conn = sqlite3.connect(db)
        conn.execute("INSERT INTO chats VALUES ('b', 'gots-b')")
        conn.commit()
        conn.close()
        self.assertEqual(self.run_it(), 0)
        rows = sqlite3.connect(db).execute("SELECT COUNT(*) FROM chats").fetchone()
        self.assertEqual(rows, (2,), "a store the new plugin has written to is never overwritten")

    def test_a_running_gateway_stops_it_before_anything_is_copied(self):
        self.assertEqual(self.run_it(gateway=lambda: {"reloaded": True}), 1)
        self.assertFalse((self.home / "plugin-data").exists())
        self.assertTrue(any("hermes gateway stop" in line for line in self.said))

    def test_no_old_folder_still_disables_and_says_so(self):
        import shutil

        shutil.rmtree(self.old)
        self.assertEqual(self.run_it(), 0)
        self.assertTrue(any("nothing to copy" in line for line in self.said))

    def test_a_rerun_does_not_overwrite_what_gots_has_changed_since(self):
        self.run_it()
        mine = store.data_dir(self.home) / "attachments" / "memento-a" / "x.txt"
        mine.write_text("newer")
        self.assertEqual(self.run_it(), 0)
        self.assertEqual(mine.read_text(), "newer")

    def test_a_failed_copy_leaves_no_partial_file_and_says_to_run_again(self):
        (self.old / "memento.db").write_text("not a database")
        self.assertEqual(self.run_it(), 1)
        self.assertEqual(list(store.data_dir(self.home).glob("*.partial")), [])
        self.assertIn("run hermes gots migrate again", self.said[-1])

    def test_home_of_undoes_db_path(self):
        self.assertEqual(store.home_of(store.db_path(self.home)), self.home)

    def test_the_dashboard_reads_the_store_where_the_plugin_writes_it(self):
        import importlib.util
        from unittest import mock

        spec = importlib.util.spec_from_file_location(
            "gots_dashboard_api", Path(store.__file__).parent / "dashboard" / "plugin_api.py"
        )
        api = importlib.util.module_from_spec(spec)
        with mock.patch.dict("sys.modules", {"fastapi": mock.MagicMock(), "pydantic": mock.MagicMock(BaseModel=object), "hermes_constants": mock.MagicMock()}):
            spec.loader.exec_module(api)
        self.run_it()
        with closing(sqlite3.connect(store.db_path(self.home))) as conn:
            conn.execute("ALTER TABLE chats ADD COLUMN deleted INTEGER DEFAULT 0")
            conn.commit()
        with mock.patch.object(api, "get_hermes_home", lambda: str(self.home)):
            self.assertEqual(api._chats(), {"exists": True, "chats": 1})


if __name__ == "__main__":
    unittest.main()
