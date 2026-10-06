"""``$HERMES_HOME/memento/memento.db``: the chat list (``chats.py``), context use (``context.py``) and
project sessions (``sessions.py``)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA_VERSION = 3


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
                   created_at INTEGER NOT NULL
               )"""
        )
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    return conn
