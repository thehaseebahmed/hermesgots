"""The skills a profile can actually run, for the app's composer ``/`` menu.

Hermes's own ``/v1/skills`` means to answer this — ``_sort_skills(_find_all_skills())``, the set
``/skills list`` shows — but it is not scoped to a profile and it passes an ``include_editorial``
kwarg the scan does not accept, so it raises and answers 500. The menu reads this instead.

``skip_disabled`` stays False, so the answer is the enabled, platform-matching, loadable skills
only: what typing ``/name`` would run. The dashboard's ``GET /api/skills`` is a different listing
(``skip_disabled=True``, plus enabled/usage/provenance for its config UI); don't reconcile this to
that one.

Both Hermes internals are private, so they are imported late: a Hermes that moved them raises
ImportError, which the route answers with a 501.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


def read(profile: Optional[str]) -> List[Dict[str, Any]]:
    # Blocking: the scan reads the skills tree and the scope swaps module globals under a lock.
    # Call from a worker thread (asyncio.to_thread), never the event loop.
    #
    # The dashboard's scope, not the plugin's own: only this one retargets the skills module's
    # globals (SKILLS_DIR, HERMES_HOME) under a lock, which is what decides whose skills are listed.
    from hermes_cli.web_server_profiles import _profile_scope
    from tools.skills_tool import _find_all_skills, _sort_skills

    with _profile_scope(profile):
        skills = _sort_skills(_find_all_skills())
    return [
        {
            "name": skill.get("name", ""),
            "description": skill.get("description", ""),
            "category": skill.get("category"),
        }
        for skill in skills
    ]
