"""Tests for the skills routes' one shape (``plugin._skill_route``).

The five skills routes are the same route: the guard, this bot's profile, one call on a worker
thread, the module's own refusal mapped to its status, and a Host whose Hermes has moved the
built-ins answering 501 — in that route's **own** sentence, since a host can list a profile's skills
and still have no way into one of them. The shapes are driven here, with a fake request and a fake
``web``, because the routes themselves are wired to an aiohttp app this repo's tests don't stand up:
the factory is the level they are checked at, and the declarations that name each route's sentence
are one line each in ``_wire_api_server``.
"""

from __future__ import annotations

import asyncio
import unittest

from plugin import _skill_route, skill_catalog


class Web:
    """aiohttp's two answers, as the factory asks for them: a JSON body and an error's own shape."""

    @staticmethod
    def json_response(payload, status=200):
        return {"payload": payload, "status": status}


class Request:
    """What a skills route reads of a request: the skill's name, its query, and its body."""

    def __init__(self, name="plan", query=None, body=None):
        self.match_info = {"name": name}
        self.query = query or {}
        self.body = body


async def body_of(request):
    """The API server's own body read, as the factory is handed it: nothing when it isn't JSON."""
    return request.body


def enabled_body(body):
    """The switch's body reader, as ``_wire_api_server`` declares it: the one field a switch says."""
    if body is None or not isinstance(body.get("enabled"), bool):
        raise ValueError('Body must be {"enabled": true} or {"enabled": false}')
    return (body["enabled"],)


def routed(call, *, key="skill", named=True, unavailable=skill_catalog.UNAVAILABLE, **kwargs):
    """One route of the factory's, with the API server's own guard, profile and body read stubbed."""
    return _skill_route(
        Web,
        call,
        key,
        guard=kwargs.pop("guard", lambda request: None),
        profile=kwargs.pop("profile", lambda: "bot-a"),
        read_body=kwargs.pop("read_body", body_of),
        named=named,
        unavailable=unavailable,
        **kwargs,
    )


def answer(handler, request=None):
    """What one request to a route answers."""
    return asyncio.run(handler(request or Request()))


class SkillRouteTests(unittest.TestCase):
    def test_the_guard_answers_first_and_the_call_never_runs(self):
        denied = {"payload": {"error": {"message": "Unauthorized"}}, "status": 401}
        handler = routed(
            lambda *args: self.fail("a denied request never reaches the call"),
            guard=lambda request: denied,
        )
        self.assertEqual(answer(handler), denied)

    def test_the_answer_is_one_row_under_the_routes_key(self):
        def call(profile, name):
            return {"name": name, "enabled": False, "profile": profile}

        handler = routed(call, key="skill")
        self.assertEqual(
            answer(handler),
            {
                "payload": {
                    "object": "skill",
                    "data": {"name": "plan", "enabled": False, "profile": "bot-a"},
                },
                "status": 200,
            },
        )

    def test_the_listing_names_no_skill_and_answers_the_list_key(self):
        seen = []

        def call(profile):
            seen.append(profile)
            return [{"name": "plan"}]

        handler = routed(call, key="list", named=False)
        self.assertEqual(
            answer(handler),
            {"payload": {"object": "list", "data": [{"name": "plan"}]}, "status": 200},
        )
        self.assertEqual(seen, ["bot-a"])

    def test_a_host_that_has_moved_the_lookups_answers_in_that_routes_own_words(self):
        def gone(profile, name):
            raise ImportError("tools.skill_manager_tool is not the module it was")

        for sentence in (
            skill_catalog.UNAVAILABLE,
            skill_catalog.UNAVAILABLE_WRITE,
            skill_catalog.UNAVAILABLE_VIEW,
            skill_catalog.UNAVAILABLE_REMOVE,
        ):
            with self.subTest(sentence=sentence):
                self.assertEqual(answer(routed(gone, unavailable=sentence))["status"], 501)
                self.assertEqual(
                    answer(routed(gone, unavailable=sentence))["payload"],
                    {"error": {"message": sentence}},
                )
        # Each flow has a sentence of its own: a sheet's refusal is never the listing's.
        self.assertEqual(
            len(
                {
                    skill_catalog.UNAVAILABLE,
                    skill_catalog.UNAVAILABLE_WRITE,
                    skill_catalog.UNAVAILABLE_VIEW,
                    skill_catalog.UNAVAILABLE_REMOVE,
                }
            ),
            4,
        )

    def test_the_modules_refusal_keeps_its_own_status(self):
        def refused(profile, name):
            raise skill_catalog.SkillError(skill_catalog.NOT_FOUND % name, 404)

        self.assertEqual(
            answer(routed(refused)),
            {"payload": {"error": {"message": "Skill 'plan' isn't on this bot."}}, "status": 404},
        )

    def test_a_switch_body_is_read_before_the_call(self):
        seen = []

        def call(profile, name, enabled):
            seen.append((profile, name, enabled))
            return {"name": name, "enabled": enabled}

        handler = routed(call, body=enabled_body)
        answer(handler, Request(body={"enabled": False}))
        self.assertEqual(seen, [("bot-a", "plan", False)])

    def test_a_body_this_route_cannot_read_is_a_400(self):
        handler = routed(
            lambda *args: self.fail("an unreadable body never reaches the call"), body=enabled_body
        )
        self.assertEqual(
            answer(handler, Request(body=None)),
            {
                "payload": {"error": {"message": 'Body must be {"enabled": true} or {"enabled": false}'}},
                "status": 400,
            },
        )

    def test_a_file_is_named_by_the_query(self):
        seen = []

        def call(profile, name, path):
            seen.append((name, path))

        handler = routed(call, key="skill.file", query="path")
        answer(handler, Request(query={"path": "references/api.md"}))
        self.assertEqual(seen, [("plan", "references/api.md")])
        self.assertEqual(
            answer(handler, Request(query={})),
            {"payload": {"error": {"message": "Missing path"}}, "status": 400},
        )


if __name__ == "__main__":
    unittest.main()
