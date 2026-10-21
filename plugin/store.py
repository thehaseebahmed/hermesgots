"""``$HERMES_HOME/memento/memento.db``: the chat list (``chats.py``), context use (``context.py``) and
the models each chat's calls ran on (``model_changes.py``), project sessions (``sessions.py``),
projects still cloning (``clones.py``), repos being added to or removed from a project (``repos.py``),
pinned projects (``projects.py``), merged pull requests (``merges.py``), a project's AFK switch
(``afk.py``) and recent changes for the app's live stream (``events.py``), devices' push
subscriptions (``push.py``) and messages waiting for a session's run (``outbox.py``) and research
missions with their evidence ledgers (``research.py``)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA_VERSION = 31


def db_path(hermes_home: Path) -> Path:
    # Outside the plugin's own folder, so `hermes plugins update` never touches it.
    return hermes_home / "memento" / "memento.db"


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=5, isolation_level=None)
    if _version(conn) < SCHEMA_VERSION:
        # One transaction: a statement at a time paid a sync to disk each, and two processes opening
        # a fresh store could both read a table's columns and both add the same one.
        try:
            conn.execute("BEGIN IMMEDIATE")
            _migrate(conn)
            conn.execute("COMMIT")
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            conn.close()
            raise
    return conn


def _version(conn: sqlite3.Connection) -> int:
    return conn.execute("PRAGMA user_version").fetchone()[0]


def _migrate(conn: sqlite3.Connection) -> None:
    # Read again under the lock: another connection may have migrated while this one waited.
    if _version(conn) < SCHEMA_VERSION:
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
        # v7: a repo being added to or removed from a ready project, and pinned projects.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS project_repos (
                   project_id TEXT NOT NULL,
                   repo TEXT NOT NULL,
                   path TEXT NOT NULL,
                   action TEXT NOT NULL,
                   status TEXT NOT NULL,
                   error TEXT,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL,
                   PRIMARY KEY (project_id, repo)
               )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS project_pins (
                   project_id TEXT PRIMARY KEY,
                   pinned_at INTEGER NOT NULL
               )"""
        )
        # v8: merged pull requests that already resolved their session.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS merged_prs (
                   session_id TEXT NOT NULL,
                   repo TEXT NOT NULL,
                   number INTEGER NOT NULL,
                   PRIMARY KEY (session_id, repo, number)
               )"""
        )
        # v9: what changed lately, for the app's live stream.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS events (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   at INTEGER NOT NULL,
                   kind TEXT NOT NULL,
                   session_id TEXT
               )"""
        )
        # v11: a device's Web Push subscription, with the VAPID key it was made with.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS push_subscriptions (
                   endpoint TEXT PRIMARY KEY,
                   device TEXT NOT NULL,
                   p256dh TEXT NOT NULL,
                   auth TEXT NOT NULL,
                   vapid_key TEXT NOT NULL,
                   subject TEXT NOT NULL,
                   created_at INTEGER NOT NULL
               )"""
        )
        # v12: messages waiting for a session's run to finish, and what each such session needs to
        # start the next one.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS outbox (
                   id TEXT PRIMARY KEY,
                   session_id TEXT NOT NULL,
                   position REAL NOT NULL,
                   text TEXT NOT NULL,
                   attachments TEXT,
                   body TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   run_id TEXT,
                   sent_at INTEGER,
                   error TEXT
               )"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS outbox_session ON outbox (session_id, position)")
        conn.execute(
            """CREATE TABLE IF NOT EXISTS outbox_sessions (
                   session_id TEXT PRIMARY KEY,
                   profile TEXT,
                   body TEXT,
                   resumed_at INTEGER NOT NULL DEFAULT 0
               )"""
        )
        # v13: what has already been pushed about a thing that can repeat. v14: the categories of push
        # a subscription wants (JSON; null is what pushed before there were more), and a bot-wide mute.
        subscription_columns = {row[1] for row in conn.execute("PRAGMA table_info(push_subscriptions)")}
        if "categories" not in subscription_columns:
            conn.execute("ALTER TABLE push_subscriptions ADD COLUMN categories TEXT")
        conn.execute(
            """CREATE TABLE IF NOT EXISTS push_prefs (
                   key TEXT PRIMARY KEY,
                   value TEXT NOT NULL
               )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS push_seen (
                   key TEXT PRIMARY KEY,
                   at INTEGER NOT NULL
               )"""
        )
        # v16: research missions, the sources and claims their researcher recorded, and what was
        # written from them.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS research_missions (
                   id TEXT PRIMARY KEY,
                   profile TEXT,
                   type TEXT NOT NULL,
                   input TEXT NOT NULL,
                   title TEXT NOT NULL,
                   goal TEXT NOT NULL,
                   format TEXT NOT NULL,
                   audience TEXT NOT NULL,
                   depth TEXT NOT NULL,
                   outline TEXT NOT NULL,
                   source_kinds TEXT NOT NULL,
                   stage TEXT NOT NULL,
                   busy TEXT,
                   error TEXT,
                   run_id TEXT,
                   formats TEXT NOT NULL,
                   making TEXT,
                   written INTEGER NOT NULL DEFAULT 0,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
               )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS research_sources (
                   mission_id TEXT NOT NULL,
                   id TEXT NOT NULL,
                   url TEXT NOT NULL,
                   title TEXT NOT NULL,
                   kind TEXT NOT NULL,
                   at INTEGER NOT NULL,
                   PRIMARY KEY (mission_id, id)
               )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS research_claims (
                   mission_id TEXT NOT NULL,
                   id TEXT NOT NULL,
                   source_id TEXT NOT NULL,
                   text TEXT NOT NULL,
                   snippet TEXT NOT NULL,
                   confidence TEXT NOT NULL,
                   at INTEGER NOT NULL,
                   PRIMARY KEY (mission_id, id)
               )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS research_outputs (
                   mission_id TEXT NOT NULL,
                   format TEXT NOT NULL,
                   content TEXT NOT NULL,
                   updated_at INTEGER NOT NULL,
                   PRIMARY KEY (mission_id, format)
               )"""
        )
        # v17: a mission's follow-up rounds (the questions the user said it missed) and the questions
        # the model thinks it still leaves open.
        mission_columns = {row[1] for row in conn.execute("PRAGMA table_info(research_missions)")}
        # v18: the rewrite under way (a follow-up's or another model's) and the model it writes with.
        for column in ("followups", "suggestions", "pending", "writer"):
            if column not in mission_columns:
                conn.execute(f"ALTER TABLE research_missions ADD COLUMN {column} TEXT")
        # v19: the model the main agent ran the research on, read from its session once it stopped.
        if "researcher" not in mission_columns:
            conn.execute("ALTER TABLE research_missions ADD COLUMN researcher TEXT")
        # v18: every version of what a mission delivered, and why it was written again.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS research_revisions (
                   mission_id TEXT NOT NULL,
                   number INTEGER NOT NULL,
                   reason TEXT NOT NULL,
                   detail TEXT,
                   outline TEXT NOT NULL,
                   outputs TEXT NOT NULL,
                   claims INTEGER NOT NULL,
                   at INTEGER NOT NULL,
                   PRIMARY KEY (mission_id, number)
               )"""
        )
        # v4: a session has a worktree in every repo of its project. v5: its newest plan file. v10: a
        # session's Theseus settings, kept so old rows and this schema agree (nothing reads it since
        # Theseus became Auto). v15: the folder its generated files go to. v25: the task AFK
        # started it for, kept with the session so its pull request still names it after the claim.
        # v28: the stage a staged task is in, and the gate its build was checked by (pipeline.py).
        columns = {row[1] for row in conn.execute("PRAGMA table_info(project_sessions)")}
        for column in ("repos", "plan_file", "theseus", "files_dir", "task", "pipeline"):
            if column not in columns:
                conn.execute(f"ALTER TABLE project_sessions ADD COLUMN {column} TEXT")
        # v20: token counts per UTC day, model and mode, for the community leaderboard.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS community_usage (
                   day TEXT NOT NULL,
                   model TEXT NOT NULL,
                   mode TEXT NOT NULL,
                   input INTEGER NOT NULL DEFAULT 0,
                   output INTEGER NOT NULL DEFAULT 0,
                   cache_write INTEGER NOT NULL DEFAULT 0,
                   cache_read INTEGER NOT NULL DEFAULT 0,
                   calls INTEGER NOT NULL DEFAULT 0,
                   PRIMARY KEY (day, model, mode)
               )"""
        )
        # v21: tokens per UTC day, provider and model, for the leaderboard's Top providers.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS community_providers (
                   day TEXT NOT NULL,
                   provider TEXT NOT NULL,
                   model TEXT NOT NULL,
                   tokens INTEGER NOT NULL DEFAULT 0,
                   PRIMARY KEY (day, provider, model)
               )"""
        )
        # v22: the model a chat's calls ran on, so its thread can show where it changed.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS model_changes (
                   session_id TEXT NOT NULL,
                   at INTEGER NOT NULL,
                   model TEXT NOT NULL,
                   provider TEXT,
                   PRIMARY KEY (session_id, at)
               )"""
        )
        # v23: a project left to work its own tasks — AFK's switch, which is the project's own
        # setting rather than the device's (afk.py).
        conn.execute(
            """CREATE TABLE IF NOT EXISTS project_afk (
                   project_id TEXT PRIMARY KEY,
                   enabled INTEGER NOT NULL,
                   at INTEGER NOT NULL
               )"""
        )
        # v24: the task AFK holds for that project, and the last refusal it met on GitHub, which the
        # app's sheet shows (afk.py). A task is one JSON row: repo, number, title, url, created_at.
        # v26: the session working that task — the one a restart adopts and the app is told about
        # when nothing is running it — and why nothing is (afk.py).
        # v27: the skills the project's AFK work follows — one to build by and the ones to critique,
        # as names from the profile's live list (afk.py).
        afk_columns = {row[1] for row in conn.execute("PRAGMA table_info(project_afk)")}
        for column, kind in (
            ("task", "TEXT"),
            ("claimed_at", "INTEGER"),
            ("refusal", "TEXT"),
            ("refused_at", "INTEGER"),
            ("session_id", "TEXT"),
            ("stalled", "TEXT"),
            ("stalled_at", "INTEGER"),
            ("build_skill", "TEXT"),
            ("critique_skills", "TEXT"),
            # v29: the workflow the project's AFK work runs under, and nothing for a project that
            # picked none, which works one prompt run instead (afk.py, ADR 0027). The two skill
            # columns above are read once, to migrate such a project into the workflow they described.
            ("workflow_id", "TEXT"),
            # v30: the Prompt the project's AFK work is told — how it is carried out, in the user's
            # own words, beside AFK's fixed brief. Empty is the bot's default method, so nothing has
            # to be stored for a project nobody has edited (prompt_builder.py).
            ("prompt", "TEXT"),
        ):
            if column not in afk_columns:
                conn.execute(f"ALTER TABLE project_afk ADD COLUMN {column} {kind}")
        # v29: the bot's workflow library — the workflow as JSON, whether it is a preset, the plugin
        # version that seeded a preset's body, and whether the user deleted it (workflows.py). A
        # deleted preset keeps its row so seeding doesn't bring back what was taken away.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS workflows (
                   id TEXT PRIMARY KEY,
                   name TEXT NOT NULL,
                   body TEXT NOT NULL,
                   preset INTEGER NOT NULL DEFAULT 0,
                   version TEXT,
                   deleted INTEGER NOT NULL DEFAULT 0,
                   at INTEGER NOT NULL
               )"""
        )
        # v31: a comparison's options and criteria, the model that judges it, and the option and
        # criterion each claim was read for (research.py).
        mission_columns = {row[1] for row in conn.execute("PRAGMA table_info(research_missions)")}
        for column in ("options", "criteria", "judge"):
            if column not in mission_columns:
                conn.execute(f"ALTER TABLE research_missions ADD COLUMN {column} TEXT")
        claim_columns = {row[1] for row in conn.execute("PRAGMA table_info(research_claims)")}
        for column in ("option_id", "criterion_id"):
            if column not in claim_columns:
                conn.execute(f"ALTER TABLE research_claims ADD COLUMN {column} TEXT")
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
