"""Run Hermes's own plugin install scanner over plugin/ and fail unless it installs without a prompt.

Usage: python3 scan-plugin.py <hermes checkout> <plugin dir>

Hermes blocks a `dangerous` verdict outright and asks for confirmation on `caution`, so anything
but `safe` is a failure here. The scanner's rules are Hermes's, read from the checkout as they are.
"""

import sys
from pathlib import Path

hermes, plugin = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
sys.path.insert(0, str(hermes))

from tools.plugin_guard import scan_plugin, should_allow_plugin_install  # noqa: E402

result = scan_plugin(plugin)
_, reason = should_allow_plugin_install(result)
print(f"Verdict: {result.verdict}")
for f in sorted(result.findings, key=lambda f: ("critical", "high", "medium", "low").index(f.severity)):
    print(f"  {f.severity.upper():<8} {f.pattern_id:<24} {f.file}:{f.line}  {f.match[:80]!r}")
print(f"Install: {reason}")
sys.exit(0 if result.verdict == "safe" else 1)
