"""A workflow stage holding for the subagents its run started, and never waking for them.

A stage moves on from its gate, and the gate reads the worktree the stage's run left behind. A run
that dispatched a subagent leaves work still being written when the run itself ends, so the end of a
stage's run is not the whole of what moves it on: every subagent that run started has to have ended
too (#469). And because a stage keeps its one run, a subagent finishing there never wakes the
session the way a chat's does.

What is pinned here is only what the plugin does to the outside: no next stage's run while a subagent
still works, the run it posts once they have all ended, the stage moving on at once for a subagent a
host died with (its row open, nothing running it), and a sweep that posts nothing for a stage
session. The session, its hold and the subagents are a real ``state.db`` and the plugin's own store;
GitHub, the worktree and the run posts are fakes.

Run: python3 -m unittest plugin.tests.test_delegation_stage -v
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest import mock

from plugin import afk, delegation, link, pipeline, sessions
from plugin.store import db_path
from plugin.tests._helpers import staged as staged_record

SESSION = "memento-afk-s1"
CHILD = "c1"
TASK = {
    "repo": "mock-user/memento",
    "number": 265,
    "title": "The frontier is read from GitHub and listed",
    "url": "https://github.com/mock-user/memento/issues/265",
}
# The worktree a gate reads once its stage has done what it said it would.
CLEAN = [{"name": "mock-user/memento", "changed": 0, "ahead": 2}]


class Adapter:
    """The API server as far as a stage's hold reads it: its run statuses, and nothing else."""

    def __init__(self) -> None:
        self._run_statuses: Dict[str, Dict[str, Any]] = {}
        self._api_key = "process-key"
        self._check_auth = lambda request: None

    def run(self, run_id: str, session_id: str, status: str, **extra: Any) -> None:
        self._run_statuses[run_id] = {
            "run_id": run_id, "session_id": session_id, "status": status, **extra,
        }


class StageCase(unittest.TestCase):
    """A task AFK holds in a staged session, with Hermes's own store beside it."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.conn = sqlite3.connect(self.home / "state.db")
        self.addCleanup(self.conn.close)
        self.conn.execute(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, model_config TEXT,"
            " parent_session_id TEXT, started_at REAL, ended_at REAL, end_reason TEXT,"
            " tool_call_count INTEGER DEFAULT 0, api_call_count INTEGER DEFAULT 0, source TEXT)"
        )
        self.conn.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT,"
            " content TEXT, tool_calls TEXT, finish_reason TEXT)"
        )
        self.clock = time.time()
        (self.home / ".env").write_text("API_SERVER_KEY=home-key\n", encoding="utf-8")
        self.adapter = Adapter()
        self.posted: List[Dict[str, Any]] = []
        self.repos = [
            {
                "name": "mock-user/memento",
                "repo_root": "/checkout",
                "path": "/trees/afk-265",
                "branch": "hermes/afk-265",
            }
        ]
        # The session the stage's work lives in, and the project that holds its task.
        sessions._upsert(db_path(self.home), SESSION, "p1", self.repos, "auto", "/checkout/files/afk-265")
        afk._upsert(
            self.home,
            "p1",
            enabled=1,
            at=int(time.time() * 1000),
        )
        # The hold is a row of its own since a project could hold several tasks (store v40): the
        # task this session works, claimed a moment ago, the way a claim writes it.
        held = afk._held_fields(TASK)
        plant = sqlite3.connect(db_path(self.home))
        plant.execute(
            """INSERT INTO holds
                   (project_id, task, repo, number, created_at, claimed_at, session_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                "p1",
                json.dumps(held),
                held["repo"],
                held["number"],
                held["created_at"],
                int(time.time()),
                SESSION,
            ),
        )
        plant.commit()
        plant.close()
        # A hold is the process's, kept across the sweep's own looks: no test may inherit another's.
        afk._held.clear()
        self.addCleanup(afk._held.clear)
        for one in (
            mock.patch.object(sessions, "adapter", self.adapter, create=True),
            mock.patch.object(sessions, "_paths", return_value=(db_path(self.home), self.home)),
            mock.patch.object(afk.ship, "status", return_value=CLEAN),
            mock.patch.object(afk, "base_branch", return_value="main"),
            mock.patch("plugin.github.pull_request", return_value={"number": 265}),
            mock.patch.object(link, "served_homes", return_value=[self.home]),
            mock.patch.object(afk, "_loop", object()),
            mock.patch.object(afk.asyncio, "run_coroutine_threadsafe", side_effect=self.schedule),
        ):
            one.start()
            self.addCleanup(one.stop)
        self.plant_post()

    def plant_post(self) -> None:
        async def post(adapter, profile, path, body, authorization=None, idempotency_key=None):
            self.posted.append({"profile": profile, "path": path, "body": body})
            return {"run_id": f"run-{len(self.posted)}"}

        wiring = mock.patch("plugin.outbox.post", side_effect=post)
        wiring.start()
        self.addCleanup(wiring.stop)

    @staticmethod
    def schedule(coroutine: Any, loop: Any) -> None:
        """Runs a stage's posting now, in its own thread: these tests have no gateway loop."""
        thread = threading.Thread(target=asyncio.run, args=(coroutine,))
        thread.start()
        thread.join()

    def staged(self, gate: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        """The task's snapshot in a build stage whose gate answered ``gate`` (a passing one)."""
        record = staged_record(pipeline.BUILD, steps=("code-review",))
        record = pipeline.gated(record, gate or [{"command": "true", "code": 0}])
        sessions.set_pipeline(db_path(self.home), SESSION, record)
        return record

    def chat(self, session_id: str = SESSION, parent: Optional[str] = None) -> None:
        """A conversation in Hermes's store: no delegation marker of its own."""
        self.clock += 1
        self.conn.execute(
            "INSERT INTO sessions (id, model, model_config, parent_session_id, started_at,"
            " ended_at, end_reason, tool_call_count, source)"
            " VALUES (?, 'm', NULL, ?, ?, NULL, NULL, 0, 'api_server')",
            (session_id, parent, self.clock),
        )
        self.conn.commit()

    def child(self, session_id: str = CHILD, parent: str = SESSION) -> None:
        """A session the conversation delegated to, still at work until ``end_child``."""
        self.clock += 1
        self.conn.execute(
            "INSERT INTO sessions (id, model, model_config, parent_session_id, started_at,"
            " ended_at, end_reason, tool_call_count, source)"
            " VALUES (?, 'anthropic/claude-sonnet-4', ?, ?, ?, NULL, NULL, 3, 'subagent')",
            (session_id, json.dumps({"_delegate_from": parent}), parent, self.clock),
        )
        self.conn.execute(
            "INSERT INTO messages (session_id, role, content) VALUES (?, 'user', 'build it')",
            (session_id,),
        )
        self.conn.commit()

    def end_child(self, session_id: str = CHILD) -> None:
        """The subagent writing its last words and closing, as Hermes records it."""
        self.conn.execute(
            "UPDATE sessions SET ended_at = ?, end_reason = 'agent_close' WHERE id = ?",
            (self.clock + 9, session_id),
        )
        self.conn.execute(
            "INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', 'done')",
            (session_id,),
        )
        self.conn.commit()

    def ended(self, **kwargs: Any) -> None:
        """The stage's own run ending, as ``on_session_end`` reports it."""
        afk.after_run(session_id=SESSION, **{"completed": True, **kwargs})

    def settle(self) -> List[str]:
        """The look the loop takes at every held stage between sweeps."""
        return asyncio.run(afk.settle_held(self.adapter))

    def kind(self) -> Optional[str]:
        record = sessions.read(db_path(self.home), SESSION) or {}
        return pipeline.kind(pipeline.read(record.get("pipeline")))


class StageHoldTests(StageCase):
    """A stage's run ending, and the subagents it started outliving it."""

    def test_the_stage_does_not_move_on_while_a_subagent_its_run_started_works(self) -> None:
        self.staged()
        self.chat()
        self.child()
        # The run that dispatched them is the one that just ended, so its children are its own.
        self.adapter.run("run-1", SESSION, "running")
        self.ended()
        self.assertEqual(self.posted, [], "the next stage must not start on a tree still being written")
        self.assertEqual(self.kind(), pipeline.BUILD, "the stage it is in is the one it ended in")

    def test_the_stage_moves_on_once_that_subagent_has_ended(self) -> None:
        self.staged()
        self.chat()
        self.child()
        self.adapter.run("run-1", SESSION, "running")
        self.ended()
        self.end_child()
        self.assertEqual(self.settle(), [SESSION])
        self.assertEqual(len(self.posted), 1, "one run: the stage the task moved to")
        self.assertEqual(self.posted[0]["body"]["session_id"], SESSION, "the same session's next run")
        self.assertIn("Review", self.posted[0]["body"]["input"][0]["content"])
        self.assertEqual(self.kind(), pipeline.CRITIQUE)

    def test_one_subagent_ending_does_not_release_the_others(self) -> None:
        """Every subagent the run started has to have ended, not merely one of them."""
        self.staged()
        self.chat()
        self.child("c1")
        self.child("c2")
        self.adapter.run("run-1", SESSION, "running")
        self.ended()
        self.end_child("c1")
        self.assertEqual(self.settle(), [], "c2 still works the tree the gate reads")
        self.assertEqual(self.posted, [])
        self.end_child("c2")
        self.assertEqual(self.settle(), [SESSION])
        self.assertEqual(len(self.posted), 1)
        self.assertEqual(self.kind(), pipeline.CRITIQUE)

    def test_a_subagent_a_host_left_open_holds_nothing(self) -> None:
        """No end recorded and no run in flight is a subagent that died with its host: it reads
        stopped, and the stage's gate isn't made to wait on a session nothing is working."""
        self.staged()
        self.chat()
        self.child()
        self.ended()
        self.assertEqual(len(self.posted), 1, "nothing is running it, so nothing is held")
        self.assertEqual(self.kind(), pipeline.CRITIQUE)

    def test_a_held_stage_settles_with_the_outcome_its_own_run_had(self) -> None:
        """A stage whose run failed stalls once its subagents end: the wait must not turn a failure
        into the finished run that would open the next stage."""
        self.staged()
        self.chat()
        self.child()
        # A claim old enough that the stall clock would report it, so "not stalled" means the hold.
        afk._update(self.home, "p1", claimed_at=int(time.time()) - afk.STALL_SECONDS - 1)
        self.adapter.run("run-1", SESSION, "running")
        self.ended(completed=False, failed=True)
        self.assertEqual(self.posted, [])
        self.assertNotIn(SESSION, afk.stalled(self.home), "a stage waiting on its subagents isn't stalled")
        self.end_child()
        self.settle()
        self.assertEqual(self.posted, [], "a failed run starts no stage")
        self.assertEqual(afk.stalled(self.home)[SESSION]["reason"], afk.FAILED_RUN)
        self.assertEqual(self.kind(), pipeline.BUILD)

    def test_a_stage_whose_subagent_never_started_moves_on_at_once(self) -> None:
        """The ordinary case: a run that dispatched nothing is judged at its own end."""
        self.staged()
        self.chat()
        self.ended()
        self.assertEqual(len(self.posted), 1)
        self.assertEqual(self.kind(), pipeline.CRITIQUE)


class StageWakeTests(StageCase):
    """A subagent's completion in a staged session: nothing to wake, because a stage keeps its run."""

    def test_a_stage_session_is_never_woken(self) -> None:
        self.staged()
        self.chat()
        self.child()
        self.end_child()
        self.assertEqual(asyncio.run(delegation.sweep(self.adapter, self.home)), 0)
        self.assertEqual(self.posted, [], "a wake would be a second run on a stage's session")
        self.assertEqual(sessions.marked_wakes(db_path(self.home), [CHILD]), set())

    def test_another_conversations_subagent_still_wakes_its_bot(self) -> None:
        """The suppression is the stage's, not every session's in the same home."""
        self.staged()
        self.chat()
        self.chat("s2")
        self.child("c2", "s2")
        self.end_child("c2")
        self.assertEqual(asyncio.run(delegation.sweep(self.adapter, self.home)), 1)
        self.assertEqual(len(self.posted), 1)
        self.assertEqual(self.posted[0]["body"]["session_id"], "s2")


if __name__ == "__main__":
    unittest.main()
