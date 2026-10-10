"""Tests for ship.handle() error propagation."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from plugin import ship


class HandleErrorPropagationTests(unittest.TestCase):
    def _handle_with_results(self, results):
        """Call handle() with ship() mocked to return the given results."""
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "memento.db"
            db_path.touch()
            record = {"session_id": "test-session", "repos": []}
            with (
                patch("plugin.sessions._paths", return_value=(db_path, Path(tmp))),
                patch("plugin.sessions.record_for", return_value=record),
                patch("plugin.ship.ship", return_value=results),
            ):
                return ship.handle(
                    {"title": "Test", "body": "Test body"},
                    task_id="test-session",
                )

    def test_handle_propagates_single_error(self):
        results = [
            {"name": "repo1", "committed": "abc123", "pushed": True, "error": "GitHub refused the push."},
        ]
        raw = self._handle_with_results(results)
        data = json.loads(raw)
        self.assertIn("error", data)
        self.assertEqual(data["error"], "GitHub refused the push.")
        self.assertNotIn("results", data)

    def test_handle_propagates_multiple_errors(self):
        results = [
            {"name": "repo1", "error": "Push failed."},
            {"name": "repo2", "error": "PR creation failed."},
        ]
        raw = self._handle_with_results(results)
        data = json.loads(raw)
        self.assertIn("error", data)
        self.assertIn("Push failed.", data["error"])
        self.assertIn("PR creation failed.", data["error"])

    def test_handle_success_results_unchanged(self):
        results = [
            {"name": "repo1", "committed": "abc123", "pushed": True, "pr": {"number": 1}},
            {"name": "repo2", "committed": "def456", "pushed": True, "pr": {"number": 2}},
        ]
        raw = self._handle_with_results(results)
        data = json.loads(raw)
        self.assertIn("results", data)
        self.assertNotIn("error", data)
        self.assertEqual(len(data["results"]), 2)

    def test_handle_mixed_results_still_reports_error(self):
        results = [
            {"name": "repo1", "committed": "abc123", "pushed": True, "pr": {"number": 1}},
            {"name": "repo2", "error": "Authentication failed."},
        ]
        raw = self._handle_with_results(results)
        data = json.loads(raw)
        self.assertIn("error", data)
        self.assertEqual(data["error"], "Authentication failed.")

    def test_handle_empty_results_unchanged(self):
        raw = self._handle_with_results([])
        data = json.loads(raw)
        self.assertIn("result", data)
        self.assertIn("Nothing to ship", data["result"])


if __name__ == "__main__":
    unittest.main()
