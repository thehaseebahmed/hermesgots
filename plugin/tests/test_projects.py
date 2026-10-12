"""Project usage tests: the per-model split against a throwaway Hermes store.

Exercises ``_fit``/``_scale`` directly and ``usage()`` end to end against a
throwaway SQLite ``state.db``, with ``hermes_cli.projects_db`` stubbed out (the
plugin only ever sees it on a real Hermes host).

Run: python3 -m unittest plugin.tests.test_projects -v
"""

from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Dict, List, Optional, Tuple

from plugin.projects import USAGE_COLUMNS, _fit, _scale, usage
from plugin.tests._helpers import stub_projects_db


class FakeFolder:
    def __init__(self, path: str) -> None:
        self.path = path


class FakeProject:
    def __init__(self, folders: List[FakeFolder]) -> None:
        self.folders = folders


SESSIONS_DDL = """
CREATE TABLE sessions (
    id TEXT,
    cwd TEXT,
    parent_session_id TEXT,
    input_tokens INT,
    output_tokens INT,
    cache_read_tokens INT,
    cache_write_tokens INT,
    actual_cost_usd REAL,
    estimated_cost_usd REAL,
    model TEXT,
    title TEXT,
    started_at REAL,
    last_activity_at REAL
)
"""

MODEL_USAGE_DDL = """
CREATE TABLE session_model_usage (
    session_id TEXT,
    model TEXT,
    input_tokens INT,
    output_tokens INT,
    cache_read_tokens INT,
    cache_write_tokens INT,
    estimated_cost_usd REAL,
    task TEXT
)
"""

FOLDER = "/work/project"


class UsageStore:
    """A throwaway Hermes home: projects.db plus a state.db we fill by hand."""

    def __init__(self, with_model_table: bool = True) -> None:
        self.tmp = TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / "projects.db").write_text("placeholder")
        self.conn = sqlite3.connect(self.home / "state.db")
        self.conn.execute(SESSIONS_DDL)
        if with_model_table:
            self.conn.execute(MODEL_USAGE_DDL)

    def add_session(
        self,
        session_id: str,
        *,
        cwd: str = FOLDER,
        parent: Optional[str] = None,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
        actual_cost: Optional[float] = None,
        estimated_cost: Optional[float] = None,
        model: str = "model-a",
        title: Optional[str] = None,
        started_at: float = 1.0,
        last_activity_at: float = 2.0,
    ) -> None:
        self.conn.execute(
            "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                session_id,
                cwd,
                parent,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                actual_cost,
                estimated_cost,
                model,
                title,
                started_at,
                last_activity_at,
            ),
        )
        # usage() reads state.db through its own connection: uncommitted rows are
        # invisible to it.
        self.conn.commit()

    def add_model_usage(
        self,
        session_id: str,
        model: str,
        *,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
        cost: float = 0.0,
        task: str = "",
    ) -> None:
        self.conn.execute(
            "INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?)",
            (
                session_id,
                model,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                cost,
                task,
            ),
        )
        self.conn.commit()

    def usage(self) -> Dict[str, Any]:
        project = FakeProject([FakeFolder(FOLDER)])
        with stub_projects_db(get_project=lambda conn, project_id: project):
            return usage(self.home, "p1")

    def close(self) -> None:
        self.conn.close()
        self.tmp.cleanup()


def _models_of(result: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Thread id -> {model name -> {token columns, cost_usd}}."""
    threads: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for thread in result["threads"]:
        models: Dict[str, Dict[str, Any]] = {}
        for entry in thread["models"]:
            models[entry["model"]] = {
                **{c: entry[c] for c in USAGE_COLUMNS},
                "cost_usd": entry["cost_usd"],
            }
        threads[thread["id"]] = models
    return threads


def _shares(counts: List[int], cost: Optional[float]) -> Dict[str, Dict[str, Any]]:
    return {"m": {"counts": list(counts), "cost": cost}}


class TestFitScale(unittest.TestCase):
    """The reconciliation helpers on their own."""

    def test_scale_distributes_the_target_exactly(self) -> None:
        shares = {
            "model-a": {"counts": [5000, 0, 0, 0], "cost": 0.0},
            "model-b": {"counts": [1000, 0, 0, 0], "cost": 0.0},
        }
        _scale(shares, 0, 6000, 1000)
        self.assertEqual([s["counts"][0] for s in shares.values()], [833, 167])
        self.assertEqual(sum(s["counts"][0] for s in shares.values()), 1000)

    def test_fit_shortfall_goes_to_the_sessions_own_model(self) -> None:
        shares = {
            "model-a": {"counts": [40, 2, 0, 0], "cost": 0.8},
            "model-b": {"counts": [30, 3, 0, 0], "cost": 0.2},
        }
        _fit(shares, [80, 5, 0, 0], 1.0, "model-b")
        # 10 input short (no output short): the session's own model, model-b, takes them.
        self.assertEqual(shares["model-a"]["counts"], [40, 2, 0, 0])
        self.assertEqual(shares["model-b"]["counts"], [40, 3, 0, 0])
        self.assertAlmostEqual(shares["model-a"]["cost"], 0.8)
        self.assertAlmostEqual(shares["model-b"]["cost"], 0.2)

    def test_fit_excess_scaled_back_proportionally(self) -> None:
        shares = {
            "model-a": {"counts": [600, 0, 0, 0], "cost": 0.6},
            "model-b": {"counts": [400, 0, 0, 0], "cost": 0.4},
        }
        _fit(shares, [500, 0, 0, 0], 0.5, "model-a")
        self.assertEqual([s["counts"][0] for s in shares.values()], [300, 200])
        self.assertAlmostEqual(sum(s["counts"][0] for s in shares.values()), 500)
        self.assertAlmostEqual(sum(s["cost"] for s in shares.values()), 0.5)

    def test_fit_zero_session_cost_zeroes_the_shares(self) -> None:
        shares = {"model-a": {"counts": [500, 5, 0, 0], "cost": 0.7}}
        _fit(shares, [500, 5, 0, 0], 0.0, "model-a")
        self.assertEqual(shares["model-a"]["counts"], [500, 5, 0, 0])
        self.assertEqual(shares["model-a"]["cost"], 0.0)

    def test_fit_unknown_session_cost_stays_unknown(self) -> None:
        shares = {"model-a": {"counts": [500, 0, 0, 0], "cost": 0.7}}
        _fit(shares, [500, 0, 0, 0], None, "model-a")
        # cost is None: the split must never name a cost the total doesn't.
        self.assertEqual(shares["model-a"]["counts"], [500, 0, 0, 0])
        self.assertEqual(shares["model-a"]["cost"], 0.0)


class TestUsage(unittest.TestCase):
    """The whole route against a throwaway store."""

    def setUp(self) -> None:
        self.store = UsageStore()

    def tearDown(self) -> None:
        self.store.close()

    def test_clean_per_call_split(self) -> None:
        """A session that switched models mid-way splits by the per-call rows."""
        self.store.add_session(
            "s1", input_tokens=80000, output_tokens=4000, cache_write_tokens=500,
            estimated_cost=1.5, model="model-b",
        )
        self.store.add_model_usage("s1", "model-a", input_tokens=50000, output_tokens=1000, cache_write_tokens=500, cost=0.4)
        self.store.add_model_usage("s1", "model-b", input_tokens=30000, output_tokens=3000, cost=1.1)
        result = self.store.usage()
        threads = _models_of(result)
        self.assertEqual(
            threads["s1"],
            {
                "model-a": {"input_tokens": 50000, "output_tokens": 1000, "cache_read_tokens": 0, "cache_write_tokens": 500, "cost_usd": 0.4},
                "model-b": {"input_tokens": 30000, "output_tokens": 3000, "cache_read_tokens": 0, "cache_write_tokens": 0, "cost_usd": 1.1},
            },
        )
        self.assertEqual(result["sessions"], 1)

    def test_pre_table_fallback_one_model_per_session(self) -> None:
        """Without session_model_usage the session row is the whole story."""
        store = UsageStore(with_model_table=False)
        try:
            store.add_session("s1", input_tokens=10000, output_tokens=2000, estimated_cost=0.9)
            project = FakeProject([FakeFolder(FOLDER)])
            with stub_projects_db(get_project=lambda conn, project_id: project):
                result = usage(store.home, "p1")
            threads = _models_of(result)
            self.assertEqual(
                threads["s1"],
                {"model-a": {"input_tokens": 10000, "output_tokens": 2000, "cache_read_tokens": 0, "cache_write_tokens": 0, "cost_usd": 0.9}},
            )
        finally:
            store.close()

    def test_shortfall_lands_on_the_sessions_own_model(self) -> None:
        """A token shortfall (queued delta, pre-table counters) goes to the session's model."""
        self.store.add_session("s1", input_tokens=70000, output_tokens=5000, estimated_cost=2.0, model="model-b")
        self.store.add_model_usage("s1", "model-a", input_tokens=40000, output_tokens=2000, cost=0.8)
        result = self.store.usage()
        threads = _models_of(result)
        self.assertEqual(threads["s1"]["model-a"]["input_tokens"], 40000)
        self.assertEqual(threads["s1"]["model-b"]["input_tokens"], 30000)
        self.assertAlmostEqual(threads["s1"]["model-a"]["cost_usd"], 0.8)
        self.assertAlmostEqual(threads["s1"]["model-b"]["cost_usd"], 1.2)

    def test_excess_scaled_back_proportionally(self) -> None:
        """Per-call rows outrunning the session row are scaled back in proportion."""
        self.store.add_session("s1", input_tokens=1000, output_tokens=100, estimated_cost=0.1)
        self.store.add_model_usage("s1", "model-a", input_tokens=5000, output_tokens=500, cost=0.9)
        result = self.store.usage()
        threads = _models_of(result)
        self.assertEqual(threads["s1"]["model-a"]["input_tokens"], 1000)
        self.assertEqual(threads["s1"]["model-a"]["output_tokens"], 100)
        self.assertAlmostEqual(threads["s1"]["model-a"]["cost_usd"], 0.1)
        self.assertEqual(result["input_tokens"], 1000)

    def test_compression_children_fold_into_the_root(self) -> None:
        """A compressed session's child row joins its parent, auxiliary calls counted."""
        self.store.add_session("s1", input_tokens=10000, output_tokens=1000, estimated_cost=0.5, title="P")
        self.store.add_session("s1c", parent="s1", input_tokens=20000, output_tokens=2000, estimated_cost=1.0, model="model-b")
        self.store.add_model_usage("s1", "model-a", input_tokens=10000, output_tokens=1000, cost=0.5)
        self.store.add_model_usage("s1c", "model-b", input_tokens=15000, output_tokens=1500, cost=0.7)
        self.store.add_model_usage("s1c", "model-b", input_tokens=5000, output_tokens=500, cost=0.3, task="compression")
        result = self.store.usage()
        threads = _models_of(result)
        self.assertEqual(len(result["threads"]), 1)
        self.assertEqual(
            threads["s1"],
            {
                "model-a": {"input_tokens": 10000, "output_tokens": 1000, "cache_read_tokens": 0, "cache_write_tokens": 0, "cost_usd": 0.5},
                "model-b": {"input_tokens": 20000, "output_tokens": 2000, "cache_read_tokens": 0, "cache_write_tokens": 0, "cost_usd": 1.0},
            },
        )
        self.assertEqual(result["sessions"], 1)

    def test_zero_usage_session_contributes_nothing(self) -> None:
        """A zero-usage session is still a session, but adds no models and no cost."""
        self.store.add_session("s1", estimated_cost=None)
        self.store.add_model_usage("s1", "model-a", input_tokens=50, output_tokens=5, cost=0.2)
        result = self.store.usage()
        threads = _models_of(result)
        # Stray per-call rows on a zero session row scale to nothing, and their
        # cost must not survive either: the split can never outrun the total.
        self.assertEqual(threads, {"s1": {}})
        self.assertEqual(result["sessions"], 1)
        self.assertIsNone(result["cost_usd"])


class TestZeroCostVsUnknownCost(unittest.TestCase):
    """The regression this file exists for: a known 0.0 cost is not an unknown one."""

    def setUp(self) -> None:
        self.store = UsageStore()

    def tearDown(self) -> None:
        self.store.close()

    def test_zero_cost_session_reports_zero_not_none(self) -> None:
        """A free session (real tokens, zero cost) reports cost_usd 0.0, not None.

        A None cost_usd reads as "unknown cost" on the app side and triggers the
        partial/"+" indicator, so a genuinely free session would wrongly show as
        "cost unknown" instead of $0.00.
        """
        self.store.add_session("s1", input_tokens=50000, output_tokens=5000, actual_cost=0.0, model="local-model")
        self.store.add_model_usage("s1", "local-model", input_tokens=50000, output_tokens=5000, cost=0.0)
        result = self.store.usage()
        threads = _models_of(result)
        self.assertEqual(threads["s1"]["local-model"]["input_tokens"], 50000)
        self.assertEqual(threads["s1"]["local-model"]["cost_usd"], 0.0)
        self.assertEqual(result["cost_usd"], 0.0)

    def test_unknown_cost_session_reports_none(self) -> None:
        """A session with no cost figure at all keeps cost_usd None (unknown)."""
        self.store.add_session("s1", input_tokens=50000, output_tokens=5000, actual_cost=None, estimated_cost=None, model="local-model")
        self.store.add_model_usage("s1", "local-model", input_tokens=50000, output_tokens=5000, cost=0.0)
        result = self.store.usage()
        threads = _models_of(result)
        self.assertEqual(threads["s1"]["local-model"]["input_tokens"], 50000)
        self.assertIsNone(threads["s1"]["local-model"]["cost_usd"])
        self.assertIsNone(result["cost_usd"])

    def test_zero_cost_share_after_reconciliation(self) -> None:
        """A share that reconciles to exactly 0.0 still reports 0.0, not None.

        Even when the per-call rows carry a nonzero cost, if the session row
        says the cost was zero, the scaled-back share is a genuine 0.0 and must
        be reported as such.
        """
        self.store.add_session("s1", input_tokens=50000, output_tokens=5000, actual_cost=0.0, model="local-model")
        self.store.add_model_usage("s1", "local-model", input_tokens=50000, output_tokens=5000, cost=0.7)
        result = self.store.usage()
        threads = _models_of(result)
        self.assertEqual(threads["s1"]["local-model"]["cost_usd"], 0.0)
        self.assertEqual(result["cost_usd"], 0.0)


if __name__ == "__main__":
    unittest.main()
