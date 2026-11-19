"""The canvas bench: fixed prompts graded on a real host, before and after the change (G11).

A canvas request was one freeform turn whose page nobody ran. A build plans, writes a draft and is
checked on the rendered page (ADR 0170, 0171). This bench is how that change is measured rather than
asserted: a fixed set of prompts, each with its own fixed assertions, sent to a real host; the
published page is graded with the step 3 runner (``plugin/canvas_checks.py``); and the record is
printed beside the machine, the model and the path, so a run is compared with the baseline or
refused as incomparable. No CI gate reads it: a run costs model calls and a page's grade is a
report, never a pass.

    python3 -m bench.canvas --dry           # a record from the canned page, no host anywhere near it
    python3 -m bench.canvas --self-check    # the bench's own rules and its host client, on a stub
    python3 -m bench.canvas --base URL --key KEY   # the prompts on a real host, read against the baseline

It runs where the host's browser layer is in reach (``tools.browser_use_cli``), the way the plugin
reaches it: on the Hermes host itself. The dictation bench (``bench/dictation/``, ADR 0075) is the
shape this one follows.
"""

from __future__ import annotations

from pathlib import Path

# What a run is read against: the "before" run's stable half, committed beside the prompts. A run
# with no baseline is refused rather than read as clean, so a deleted file cannot turn the
# comparison off.
BASELINE = Path(__file__).resolve().parent / "baseline.json"
