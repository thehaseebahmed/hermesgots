"""``$HERMES_HOME/memento/memento.db``: the chat list (``chats.py``), context use (``context.py``) and
the models each chat's calls ran on (``model_changes.py``), project sessions (``sessions.py``),
projects still cloning (``clones.py``), repos being added to or removed from a project (``repos.py``),
pinned projects (``projects.py``), merged pull requests (``merges.py``), a project's AFK switch and
the tasks it holds (``afk.py``) and recent changes for the app's live stream (``events.py``), devices'
push subscriptions (``push.py``) and messages waiting for a session's run (``outbox.py``) and research
missions with their evidence ledgers (``research.py``), and the dictations a bot has heard
(``dictations.py``)."""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# 43 is not a change of its own: it is v42's block, reached again. That block shipped as v42 on this
# branch before the ``chat_session`` index joined it, so a store already at 42 would never run it and
# would keep table-scanning the chat list — the cost that index exists to remove. Re-running the block
# is safe: every ALTER is PRAGMA-guarded and every index says IF NOT EXISTS, so a v42 store builds the
# index and a v41 store reaches 43 in one pass.
# 44 adds the dictation log and the clock a clear stamps (ADR 0060), both new tables. 45 rebuilds the
# log keyed per profile, and 46 adds the clock its reads order on, so both of those are PRAGMA-guarded
# or `IF NOT EXISTS`: a store already carrying them has to reach 47 without re-running either. 47
# replaces the log's index with the one every read asks for.
SCHEMA_VERSION = 47


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


def get_setting(path: Path, key: str) -> Optional[Any]:
    """A value kept in ``host_settings`` (JSON), or None when it isn't there."""
    if not path.exists():
        return None
    conn = connect(path)
    try:
        row = conn.execute("SELECT value FROM host_settings WHERE key = ?", (key,)).fetchone()
    finally:
        conn.close()
    try:
        return json.loads(row[0]) if row else None
    except ValueError:
        logger.debug("memento: the %s setting isn't valid JSON", key)
        return None


def put_setting(path: Path, key: str, value: Optional[Any]) -> None:
    """Keeps ``value`` (JSON) under ``key`` in ``host_settings``; None removes it."""
    if value is None and not path.exists():
        return
    conn = connect(path)
    try:
        if value is None:
            conn.execute("DELETE FROM host_settings WHERE key = ?", (key,))
        else:
            conn.execute(
                "INSERT OR REPLACE INTO host_settings (key, value) VALUES (?, ?)",
                (key, json.dumps(value)),
            )
    finally:
        conn.close()


def open_rows(path: Path) -> sqlite3.Connection:
    """A store's connection, with rows a reader can name a column on."""
    conn = connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def now_ms() -> int:
    """The host's clock, in the unit the log is stamped in."""
    return int(time.time() * 1000)


def _version(conn: sqlite3.Connection) -> int:
    return conn.execute("PRAGMA user_version").fetchone()[0]


def _carry_hold(conn: sqlite3.Connection, row: Any) -> None:
    """Moves one project's pre-v40 held task into a row of its own, as the store's first hold.

    The task is copied verbatim — the sheet reads it as it is — and its repository and number are
    read out of it for the key. A row whose task isn't JSON, or names no repository or number, is
    nothing one can hold, so the INSERT's IGNORE drops it rather than failing the migration.
    """
    project_id, task, session_id, claimed_at, stalled, stalled_at = row
    try:
        held = json.loads(task) if isinstance(task, str) and task else None
    except ValueError:
        return
    if not isinstance(held, dict):
        return
    conn.execute(
        """INSERT OR IGNORE INTO holds
               (project_id, task, repo, number, created_at, claimed_at, session_id, stalled, stalled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            project_id,
            task,
            held.get("repo"),
            held.get("number"),
            held.get("created_at"),
            claimed_at,
            session_id,
            stalled,
            stalled_at,
        ),
    )


# Every read of the log, off one index: a page is ordered by `(seen_at, id)` — which `(profile,
# seen_at)` could only answer by sorting the profile's whole log to hand back 50 — and the totals add
# two integers from the same rows, which fetching every row's words cost (ADR 0060).
CREATE_DICTATION_READ = """CREATE INDEX IF NOT EXISTS dictation_read
               ON dictations (profile, seen_at, id, words, ms)"""

# A finished take, as both the first create and the rebuild need it.
CREATE_DICTATIONS = """CREATE TABLE IF NOT EXISTS dictations (
                   id TEXT NOT NULL,
                   profile TEXT NOT NULL DEFAULT '',
                   text TEXT NOT NULL,
                   words INTEGER NOT NULL DEFAULT 0,
                   ms INTEGER NOT NULL DEFAULT 0,
                   at INTEGER NOT NULL,
                   PRIMARY KEY (profile, id)
               )"""


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
        # v32: the messages triage sent out of a Main thread, for its Moved markers (moves.py).
        # v33: a v32 store also had a thread_session column nothing read; it is rebuilt without it.
        move_columns = {row[1] for row in conn.execute("PRAGMA table_info(main_moves)")}
        if "thread_session" in move_columns:
            conn.execute("ALTER TABLE main_moves RENAME TO main_moves_old")
            conn.execute("DROP INDEX IF EXISTS main_moves_session")
        conn.execute(
            """CREATE TABLE IF NOT EXISTS main_moves (
                   id TEXT PRIMARY KEY,
                   session_id TEXT NOT NULL,
                   text TEXT NOT NULL,
                   thread TEXT NOT NULL,
                   at INTEGER NOT NULL,
                   undone INTEGER NOT NULL DEFAULT 0
               )"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS main_moves_session ON main_moves (session_id, at)")
        if "thread_session" in move_columns:
            conn.execute(
                """INSERT INTO main_moves (id, session_id, text, thread, at, undone)
                   SELECT id, session_id, text, thread, at, undone FROM main_moves_old"""
            )
            conn.execute("DROP TABLE main_moves_old")
        # v34: settings the host keeps for the bot that aren't Hermes's own config: the triage model
        # (triage.py).
        conn.execute(
            """CREATE TABLE IF NOT EXISTS host_settings (
                   key TEXT PRIMARY KEY,
                   value TEXT NOT NULL
               )"""
        )
        # v35: what Undo needs of a move: its thread's session and queued item, whether the move
        # opened the thread, and the message as Main would have run it.
        move_columns = {row[1] for row in conn.execute("PRAGMA table_info(main_moves)")}
        for column, kind in (
            ("thread_session", "TEXT"),
            ("item", "TEXT"),
            ("new", "INTEGER NOT NULL DEFAULT 0"),
            ("main_body", "TEXT"),
            ("files", "TEXT"),
        ):
            if column not in move_columns:
                conn.execute(f"ALTER TABLE main_moves ADD COLUMN {column} {kind}")
        # v36: meetings and their audio parts, uploaded in pieces and transcribed on the host (meetings.py).
        conn.execute(
            """CREATE TABLE IF NOT EXISTS meetings (
                   id TEXT PRIMARY KEY,
                   profile TEXT,
                   title TEXT NOT NULL,
                   project_id TEXT,
                   kind TEXT NOT NULL,
                   stage TEXT NOT NULL,
                   parts INTEGER NOT NULL DEFAULT 0,
                   error TEXT,
                   transcript TEXT NOT NULL DEFAULT '[]',
                   duration INTEGER NOT NULL DEFAULT 0,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
               )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS meeting_parts (
                   meeting_id TEXT NOT NULL,
                   n INTEGER NOT NULL,
                   start INTEGER NOT NULL,
                   content_type TEXT,
                   size INTEGER NOT NULL,
                   done INTEGER NOT NULL DEFAULT 0,
                   segments TEXT,
                   PRIMARY KEY (meeting_id, n)
               )"""
        )
        # v37: the notes written from a meeting's transcript, as JSON (meetings.py).
        meeting_columns = {row[1] for row in conn.execute("PRAGMA table_info(meetings)")}
        if "notes" not in meeting_columns:
            conn.execute("ALTER TABLE meetings ADD COLUMN notes TEXT")
        # v38: the questions asked about a meeting and the answers, in order (meetings.py).
        conn.execute(
            """CREATE TABLE IF NOT EXISTS meeting_chat (
                   meeting_id TEXT NOT NULL,
                   n INTEGER NOT NULL,
                   role TEXT NOT NULL,
                   text TEXT NOT NULL,
                   cites TEXT NOT NULL DEFAULT '[]',
                   at INTEGER NOT NULL,
                   PRIMARY KEY (meeting_id, n)
               )"""
        )
        # v40: a project works several tasks at once, so a hold is a row of its own instead of
        # columns on the project: one per claimed task, carrying the session working it and its own
        # stall clock (afk.py, ADR 0025). The task is the JSON the sheet already reads, and its
        # repository and number are what keep the same task from being held twice.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS holds (
                   project_id TEXT NOT NULL,
                   task TEXT NOT NULL,
                   repo TEXT NOT NULL,
                   number INTEGER NOT NULL,
                   created_at TEXT,
                   claimed_at INTEGER,
                   session_id TEXT,
                   stalled TEXT,
                   stalled_at INTEGER,
                   PRIMARY KEY (project_id, repo, number)
               )"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS holds_session ON holds (session_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS holds_project ON holds (project_id, created_at)")
        afk_columns = {row[1] for row in conn.execute("PRAGMA table_info(project_afk)")}
        for column, kind in (
            # How many tasks the project may hold at once, nothing being one (afk.py).
            ("pick_count", "INTEGER"),
            # The prompt library entry the project's Prompt was copied from, and nothing for a
            # Prompt nobody copied (ADR 0043).
            ("prompt_id", "TEXT"),
        ):
            if column not in afk_columns:
                conn.execute(f"ALTER TABLE project_afk ADD COLUMN {column} {kind}")
        # The one hold a project could have before this becomes its first row, with the session
        # working it and the clock it was claimed on. The old columns stay, as v29's and v30's do,
        # and are left as they are: nothing reads them now, and a copy is what a store older than
        # this is upgraded from — with its own version already past 40, it is never copied twice.
        if "task" in afk_columns:
            for row in conn.execute(
                """SELECT project_id, task, session_id, claimed_at, stalled, stalled_at
                   FROM project_afk WHERE task IS NOT NULL"""
            ).fetchall():
                _carry_hold(conn, row)
        # v39: the wake posted for a finished subagent, and the live id a card stops it by — both
        # keyed by the child's own session id, since that is all the app has (delegation.py).
        conn.execute(
            """CREATE TABLE IF NOT EXISTS subagent_wakes (
                   subagent_id TEXT PRIMARY KEY,
                   parent_id TEXT NOT NULL,
                   run_id TEXT,
                   at INTEGER NOT NULL
               )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS subagent_agents (
                   subagent_id TEXT PRIMARY KEY,
                   agent_id TEXT NOT NULL,
                   at INTEGER NOT NULL
               )"""
        )
        # v41: a wake is a batch per conversation, and it can be held, retried with a backoff or
        # dropped for a reason, so a mark carries what became of it (delegation.py). The columns
        # are additive: an older plugin reads the old ones and leaves these alone.
        wake_columns = {row[1] for row in conn.execute("PRAGMA table_info(subagent_wakes)")}
        for column, kind in (
            # NULL is a mark a v40 store wrote: a wake already posted, so it stays settled.
            ("status", "TEXT"),
            ("attempts", "INTEGER NOT NULL DEFAULT 0"),
            # Epoch ms the next attempt may go at; NULL when no backoff is pending.
            ("next_at", "INTEGER"),
            ("reason", "TEXT"),
        ):
            if column not in wake_columns:
                conn.execute(f"ALTER TABLE subagent_wakes ADD COLUMN {column} {kind}")
        # A batch's intent, written before its post so a restart mid-post re-posts the same key
        # instead of a second run. ``run_id`` stays NULL until the post answered.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS subagent_wake_batches (
                   id TEXT PRIMARY KEY,
                   root TEXT NOT NULL,
                   members TEXT NOT NULL,
                   text TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   run_id TEXT
               )"""
        )
        # v42: the batch's intent also carries the model its run is posted with (delegation.py), for
        # the same reason it carries the text: a retry has to re-post the same bytes under the
        # batch's key, and a pin read again at the post would be a changed payload core refuses.
        # Additive, and NULL on a batch written before this: its retry names no model, as every
        # wake did then.
        batch_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(subagent_wake_batches)")
        }
        for column in ("provider", "model"):
            if column not in batch_columns:
                conn.execute(f"ALTER TABLE subagent_wake_batches ADD COLUMN {column} TEXT")
        # The watcher asks for a conversation's unconfirmed batch on every look; the partial
        # index keeps that a handful of rows on a store that has carried years of finished ones.
        conn.execute(
            """CREATE INDEX IF NOT EXISTS wake_batch_open
                   ON subagent_wake_batches (root, created_at) WHERE run_id IS NULL"""
        )
        # The orphan pass asks for every still-held wake on every look; the partial index keeps
        # that off the sent rows a store accumulates, one per posted wake.
        conn.execute(
            """CREATE INDEX IF NOT EXISTS held_wakes
                   ON subagent_wakes (parent_id) WHERE status = 'held'"""
        )
        # The chat list is keyed by chat id, but a run knows only its Hermes session — which an app
        # chat keeps inside its value. The delegation sweep asks for one of those per conversation
        # every 5 seconds, so the expression index answers it off the row that names the session
        # instead of decoding every chat in the store (chats.by_session). A value that isn't JSON
        # stops the index being built, and that chat list is already one `chats.read` can't read:
        # saying so is better than refusing the migration, and the store every other reader uses.
        try:
            conn.execute(
                """CREATE INDEX IF NOT EXISTS chat_session
                       ON chats (json_extract(value, '$.hermesSessionId'))"""
            )
        except sqlite3.Error:
            logger.debug("memento: the chat list carries a value that isn't JSON")
        # v44: a bot's dictations — one row per finished take, written by the app when its words
        # landed — and the clock its last clear stamped, which is how a device's mirror learns that
        # its rows above the stamp are gone without comparing ids (dictations.py, ADR 0060).
        conn.execute(CREATE_DICTATIONS)
        conn.execute(
            """CREATE TABLE IF NOT EXISTS dictation_state (
                   profile TEXT PRIMARY KEY,
                   cleared_at INTEGER NOT NULL DEFAULT 0
               )"""
        )
        # v45: the log is keyed per profile, and `device` is gone. A store that ran the build before
        # that change has `id` alone as its key, where a second profile's write of the same id is
        # dropped by INSERT OR IGNORE and then read back as a row it never stored. CREATE TABLE IF
        # NOT EXISTS cannot change a key, so the table is rebuilt with its rows carried over.
        columns = {row[1] for row in conn.execute("PRAGMA table_info(dictations)")}
        if "device" in columns:
            conn.execute("ALTER TABLE dictations RENAME TO dictations_v44")
            conn.execute(CREATE_DICTATIONS)
            # `id` was unique in the old shape, so no row can collide with another on the way in.
            conn.execute(
                """INSERT OR IGNORE INTO dictations (id, profile, text, words, ms, at)
                       SELECT id, profile, text, words, ms, at FROM dictations_v44"""
            )
            conn.execute("DROP TABLE dictations_v44")
        # v46: the log's clock is the host's (dictations.py, ADR 0060). `at` is when the words were
        # said, which a device's clock decides and a wrong one misplaces; the order, the pages and the
        # fingerprint read `seen_at`, stamped when the row landed. Rows written before this are
        # backfilled with their own `at`, which is the order they were already read in, so nothing
        # moves for a store that has been in use.
        dictation_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(dictations)")
        }
        if "seen_at" not in dictation_columns:
            conn.execute("ALTER TABLE dictations ADD COLUMN seen_at INTEGER NOT NULL DEFAULT 0")
            conn.execute("UPDATE dictations SET seen_at = at")
        # The page no longer reads `at`, so its index would only cost every write.
        conn.execute("DROP INDEX IF EXISTS dictation_time")
        # v47: one index for all three reads of the log (CREATE_DICTATION_READ).
        conn.execute("DROP INDEX IF EXISTS dictation_order")
        conn.execute(CREATE_DICTATION_READ)
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
