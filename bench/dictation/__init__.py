"""Dictation on the host: the bench's own parts.

Importing this package puts the repository root on the path, because the bench drives ``plugin``'s
own take functions from a checkout rather than from an installed plugin.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FIXTURES = HERE / "fixtures"
BASELINE = HERE / "baseline.json"

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
