
from __future__ import annotations

import asyncio
import unittest

from plugin import _named, _plugin_route, skill_catalog


class Web:

    @staticmethod
    def json_response(payload, status=200):
        return {"payload": payload, "status": status}


class Request:

    def __init__(self, name="plan", query=None, body=None):
        self.match_info = {"name": name}
        self.query = query or {}
        self.body = body


async def body_of(request):
    return request.body


def enabled_body(body):
    if body is None or not isinstance(body.get("enabled"), bool):
        raise ValueError('Body must be {"enabled": true} or {"enabled": false}')
    return (body["enabled"],)


def routed(call, *, key="skill", named=True, unavailable=skill_catalog.UNAVAILABLE, **kwargs):
    return _plugin_route(
        Web,
        call,
        guard=kwargs.pop("guard", lambda request: None),
        profile=kwargs.pop("profile", lambda: "bot-a"),
        read_body=kwargs.pop("read_body", body_of),
        error=skill_catalog.SkillError,
        answer=_named(key),
        named=named,
        unavailable=unavailable,
        **kwargs,
    )


def answer(handler, request=None):
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
