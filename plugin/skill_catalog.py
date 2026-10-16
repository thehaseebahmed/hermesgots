"""The skills a profile can actually run, for the app's composer ``/`` menu.

Hermes's own ``/v1/skills`` lists the launch profile's skills and fails on current Hermes, so the
menu reads this instead. It is the same listing the dashboard's ``GET /api/skills`` makes, run
under the request's profile scope: the profile's skills directory and its ``skills.disabled``
config decide the result. ``skip_disabled`` stays False, so disabled skills are left out by the
scan's own rules and platform-mismatched ones are too, which is what ``/name`` would invoke.

Both Hermes internals are private, so they are imported late: a Hermes that moved them raises
ImportError, which the route answers with a 501.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


def read(profile: Optional[str]) -> List[Dict[str, Any]]:
    # Blocking: the scan reads the skills tree and the scope swaps module globals under a lock.
    # Call from a worker thread (asyncio.to_thread), never the event loop.
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
