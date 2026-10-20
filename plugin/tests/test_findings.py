"""The findings tool: what each review skill reported, kept on the stage's round and counted there.

A throwaway Hermes home with the plugin's own store, so the answer read back is the record the sheet
will read — the same prior art as the gate's and the todos' tests.

Run: python3 -m unittest plugin.tests.test_findings -v
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Dict, List, Optional
from unittest.mock import patch

from plugin import findings, pipeline, sessions
from plugin.store import db_path
from plugin.tests._helpers import staged as staged_record

SESSION = "memento-afk-findings"


class FindingsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        sessions._upsert(
            db_path(self.home),
            SESSION,
            "p1",
            [
                {
                    "name": "mock-user/memento",
                    "repo_root": str(self.home / "checkout"),
                    "path": str(self.home / "trees" / "afk-337"),
                    "branch": "hermes/afk-337",
                }
            ],
            "auto",
            None,
        )
        patcher = patch("plugin.sessions._paths", return_value=(db_path(self.home), self.home))
        patcher.start()
        self.addCleanup(patcher.stop)

    def staged(self, stage: str = pipeline.CRITIQUE, skills=("code-review", "log-triage")) -> Dict[str, Any]:
        if not skills:
            sessions.set_pipeline(db_path(self.home), SESSION, None)
            return {}
        record = staged_record(stage, steps=tuple(skills))
        sessions.set_pipeline(db_path(self.home), SESSION, record)
        return record

    def read(self) -> Optional[Dict[str, Any]]:
        return pipeline.read(sessions.read(db_path(self.home), SESSION)["pipeline"])

    def call(self, args: Any, session_id: Optional[str] = SESSION) -> Dict[str, Any]:
        return json.loads(findings.handle(args, session_id=session_id))

    def counts(self) -> Dict[str, int]:
        return {one["skill"]: len(one["findings"]) for one in pipeline.stage_findings(self.read())}

    def test_one_skills_three_findings_and_anothers_none_are_three_and_zero(self) -> None:
        self.staged()
        self.call(
            {
                "skill": "code-review",
                "findings": [
                    {"title": "a leak", "detail": "the pool is never closed"},
                    {"title": "a dead branch"},
                    "a typo in the log line",
                ],
            }
        )
        self.call({"skill": "log-triage", "findings": []})
        self.assertEqual(
            self.counts(),
            {"code-review": 3, "log-triage": 0},
            "a skill that found nothing is a zero, not a skill nobody hears about",
        )

    def test_a_finding_keeps_its_title_and_detail(self) -> None:
        self.staged()
        self.call(
            {
                "skill": "code-review",
                "findings": [{"title": "a leak", "detail": "the pool is never closed"}, "a typo"],
            }
        )
        reports = pipeline.stage_findings(self.read())
        self.assertEqual(
            reports[0]["findings"],
            [
                {"title": "a leak", "detail": "the pool is never closed"},
                {"title": "a typo", "detail": None},
            ],
        )

    def test_a_second_report_for_a_skill_replaces_the_first(self) -> None:
        self.staged()
        self.call({"skill": "code-review", "findings": ["one", "two", "three"]})
        self.call({"skill": "code-review", "findings": ["one"]})
        self.assertEqual(self.counts(), {"code-review": 1})

    def test_findings_are_capped(self) -> None:
        self.staged()
        answer = self.call(
            {"skill": "code-review", "findings": [f"finding-{index}" for index in range(pipeline.FINDING_CAP + 5)]}
        )
        self.assertEqual(answer["reported"], pipeline.FINDING_CAP)
        self.assertEqual(self.counts()["code-review"], pipeline.FINDING_CAP)

    def test_a_call_naming_no_findings_list_is_refused(self) -> None:
        self.staged()
        for args in ({"skill": "code-review"}, {"skill": "code-review", "findings": "none"}):
            self.assertIn("error", self.call(args), f"{args} reports nothing")
        self.assertEqual(pipeline.stage_findings(self.read()), [], "a refused call records nothing")

    def test_a_call_naming_no_skill_is_refused(self) -> None:
        self.staged()
        self.assertIn("error", self.call({"findings": ["one"]}))

    def test_a_session_that_is_not_staged_is_refused(self) -> None:
        self.staged(skills=())
        answer = self.call({"skill": "code-review", "findings": ["one"]})
        self.assertIn("isn't a staged task", answer["error"])

    def test_an_unknown_session_is_refused(self) -> None:
        self.staged()
        answer = self.call({"skill": "code-review", "findings": ["one"]}, session_id="memento-nope")
        self.assertIn("error", answer)
        self.assertEqual(pipeline.stage_findings(self.read()), [])

    def test_the_report_lands_on_the_stage_the_review_is_in(self) -> None:
        self.staged(stage=pipeline.CRITIQUE)
        self.call({"skill": "code-review", "findings": ["one"]})
        record = self.read()
        self.assertEqual(
            pipeline.stage_findings(record)[0]["findings"],
            [{"title": "one", "detail": None}],
        )
        self.assertEqual(
            pipeline.stage_findings(record, 0),
            [],
            "the stage the run is in holds it, and no other stage does",
        )

    def test_the_report_is_on_the_round_the_review_is_working(self) -> None:
        self.staged()
        self.call({"skill": "code-review", "findings": ["one"]})
        record = self.read()
        self.assertEqual(
            record["stages"][record["stage"]]["rounds"][-1]["findings"],
            [{"skill": "code-review", "findings": [{"title": "one", "detail": None}]}],
            "the round the review is working holds it, where the sheet reads it",
        )


if __name__ == "__main__":
    unittest.main()
