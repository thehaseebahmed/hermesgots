"""Tests for ship.handle() error propagation and partial-success preservation."""

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

    def test_handle_mixed_results_preserves_success_and_reports_error(self):
        """Mixed success: per-repo results are preserved alongside the top-level error."""
        results = [
            {"name": "repo1", "committed": "abc123", "pushed": True, "pr": {"number": 1}},
            {"name": "repo2", "error": "Authentication failed."},
        ]
        raw = self._handle_with_results(results)
        data = json.loads(raw)
        self.assertIn("error", data)
        self.assertEqual(data["error"], "Authentication failed.")
        self.assertIn("results", data)
        self.assertEqual(len(data["results"]), 2)
        self.assertEqual(data["results"][0]["name"], "repo1")
        self.assertEqual(data["results"][0]["pushed"], True)
        self.assertIn("pr", data["results"][0])
        self.assertEqual(data["results"][1]["name"], "repo2")
        self.assertIn("error", data["results"][1])

    def test_handle_mixed_results_no_error_key_on_success(self):
        """A successful repo in a mixed result set has no 'error' key."""
        results = [
            {"name": "repo1", "committed": "abc123", "pushed": True, "pr": {"number": 1}},
            {"name": "repo2", "error": "Auth failed."},
        ]
        raw = self._handle_with_results(results)
        data = json.loads(raw)
        success = [r for r in data["results"] if "error" not in r]
        self.assertEqual(len(success), 1)
        self.assertEqual(success[0]["name"], "repo1")

    def test_handle_empty_results_unchanged(self):
        raw = self._handle_with_results([])
        data = json.loads(raw)
        self.assertIn("result", data)
        self.assertIn("Nothing to ship", data["result"])

    def test_detect_tool_failure_on_mixed_result(self):
        """Hermes _detect_tool_failure recognizes a dict with a truthy 'error' key as failure."""
        results = [
            {"name": "repo1", "committed": "abc123", "pushed": True, "pr": {"number": 1}},
            {"name": "repo2", "error": "Auth failed."},
        ]
        raw = self._handle_with_results(results)
        data = json.loads(raw)
        # Simulate _detect_tool_failure's dict path:
        #   err = data.get("error") or data.get("message")
        #   if err and (failed or "error" in data): -> True
        err = data.get("error") or data.get("message")
        self.assertTrue(err and "error" in data, "mixed result must be detected as failure")

    def test_detect_tool_failure_not_triggered_on_success(self):
        """A pure-success result must not be flagged as failure."""
        results = [
            {"name": "repo1", "committed": "abc123", "pushed": True, "pr": {"number": 1}},
        ]
        raw = self._handle_with_results(results)
        data = json.loads(raw)
        err = data.get("error") or data.get("message")
        self.assertFalse(err, "all-success result must not be detected as failure")


if __name__ == "__main__":
    unittest.main()
