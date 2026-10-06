"""``$HERMES_HOME/memento/memento.db``: the chat list (``chats.py``), context use (``context.py``) and
project sessions (``sessions.py``) and
projects still cloning (``clones.py``)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA_VERSION = 6


def db_path(hermes_home: Path) -> Path:
    # Outside the plugin's own folder, so `hermes plugins update` never touches it.
    return hermes_home / "memento" / "memento.db"


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=5, isolation_level=None)
    if conn.execute("PRAGMA user_version").fetchone()[0] < SCHEMA_VERSION:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS chats (
                   id TEXT PRIMARY KEY,
                   at INTEGER NOT NULL,
                   deleted INTEGER NOT NULL DEFAULT 0,
                   value TEXT
               )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS context (
                   session_id TEXT PRIMARY KEY,
                   prompt_tokens INTEGER NOT NULL,
                   output_tokens INTEGER,
                   context_length INTEGER,
                   model TEXT,
                   provider TEXT,
                   at INTEGER NOT NULL
               )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS project_sessions (
                   session_id TEXT PRIMARY KEY,
                   project_id TEXT NOT NULL,
                   repo_root TEXT NOT NULL,
                   path TEXT,
                   branch TEXT,
                   mode TEXT NOT NULL DEFAULT 'accept_edits',
                   plan_pending INTEGER NOT NULL DEFAULT 0,
                   created_at INTEGER NOT NULL,
                   repos TEXT,
                   plan_file TEXT
               )"""
        )
        # v6: a project whose repos are still being cloned, or whose clone failed.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS project_clones (
                   slug TEXT PRIMARY KEY,
                   name TEXT NOT NULL,
                   description TEXT,
                   repos TEXT NOT NULL,
                   status TEXT NOT NULL,
                   error TEXT,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
               )"""
        )
        # v4: a session has a worktree in every repo of its project. v5: its newest plan file.
        columns = {row[1] for row in conn.execute("PRAGMA table_info(project_sessions)")}
        for column in ("repos", "plan_file"):
            if column not in columns:
                conn.execute(f"ALTER TABLE project_sessions ADD COLUMN {column} TEXT")
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    return conn
