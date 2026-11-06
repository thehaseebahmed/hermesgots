"""``link.is_linked`` answers for the site being linked to, not the one a copied state names."""

import unittest
from unittest import mock

from plugin import link


class IsLinkedSiteTest(unittest.TestCase):
    state = {"token": "mh_old", "site": "https://old.example", "inbox": {}}

    def test_state_claimed_at_another_site_is_not_linked_there(self):
        with mock.patch.object(link, "call") as call:
            self.assertFalse(link.is_linked(self.state, "https://new.example"))
        call.assert_not_called()

    def test_same_site_still_asks_the_registry(self):
        with mock.patch.object(link, "call", return_value={}) as call:
            self.assertTrue(link.is_linked(self.state, "https://old.example"))
        call.assert_called_once()

    def test_registry_not_knowing_the_token_is_not_linked(self):
        with mock.patch.object(link, "call", side_effect=link.LinkError("no", 401)):
            self.assertFalse(link.is_linked(self.state, "https://old.example"))


if __name__ == "__main__":
    unittest.main()
