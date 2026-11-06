"""One background watcher: a loop that looks again on its own tick or when it is poked.

The plugin keeps several of these — the message queue, the routine messages that waited — and each is
the same shape: Hermes's hooks run in other threads, so a hook that has something to say pokes the
watcher rather than waiting for its next tick, and a watcher that has never run (no loop yet) is
simply left alone.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable, Optional

from . import events

logger = logging.getLogger(__name__)


class Ticker:
    """A named watcher: ``run`` loops for as long as the server runs, ``wake`` pokes it from anywhere."""

    def __init__(self, name: str) -> None:
        self.name = name
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._event: Optional[asyncio.Event] = None

    def wake(self) -> None:
        """Has the watcher look again now; safe from any thread."""
        events.poke(self._loop, self._event)

    async def run(
        self,
        every: float,
        tick: Callable[[], Any],
        *,
        before: Optional[Callable[[], Awaitable[None]]] = None,
    ) -> None:
        """Loops until cancelled, calling ``tick`` after each tick or poke; ``before`` runs once."""
        self._loop = asyncio.get_running_loop()
        self._event = asyncio.Event()
        if before is not None:
            try:
                await before()
            except Exception:
                logger.debug("gots: the %s watcher couldn't start up", self.name, exc_info=True)
        while True:
            try:
                await asyncio.wait_for(self._event.wait(), every)
            except asyncio.TimeoutError:
                pass
            self._event.clear()
            try:
                result = tick()
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                logger.debug("gots: the %s watcher failed", self.name, exc_info=True)
