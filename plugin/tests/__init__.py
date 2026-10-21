"""Plugin tests package.

The suite runs on whatever machine runs it, and a developer's has a GitHub login where CI's
runner has none, so a test that reached GitHub passed or failed by who ran it. Before any test
module loads, this takes the machine's own GitHub account out of reach — its tokens and the `gh`
CLI's — and refuses every request off this host, so a test that would reach the network fails
by name wherever it runs. A test that needs a token or an answer from GitHub patches one in.
"""

from __future__ import annotations

import ipaddress
import os
import urllib.parse
import urllib.request

from plugin import github


class NetworkInTests(RuntimeError):
    """A test reached for a host off this machine: patch the call it makes."""


def _loopback(url: str) -> bool:
    host = urllib.parse.urlsplit(url).hostname or ""
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


_urlopen = urllib.request.urlopen


def _guarded_urlopen(request, *args, **kwargs):  # type: ignore[no-untyped-def]
    url = request.full_url if isinstance(request, urllib.request.Request) else str(request)
    if not _loopback(url):
        raise NetworkInTests(f"a test reached the network: {url}")
    return _urlopen(request, *args, **kwargs)


for _name in github.TOKEN_ENV_VARS:
    os.environ.pop(_name, None)
github._gh_cli_token = lambda: None
urllib.request.urlopen = _guarded_urlopen
