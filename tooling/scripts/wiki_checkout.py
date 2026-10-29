"""Whether the doc-drift tests can compare against the wiki checkout.

CART.wiki is a git submodule, so a clone made without `--recurse-submodules`
leaves the directory EMPTY. Skipping there made a test pass while checking
nothing, so an empty checkout is a failure unless CART_TEST_ALLOW_MISSING
names `wiki` (or `all`), the gate's named opt-out for an input a working copy
lacks. The TypeScript twin is webapp/src/lib/wikiCheckout.testUtils.ts.
"""
from __future__ import annotations

import os
from pathlib import Path

SKIP_REASON = "SKIPPED: no wiki checkout, allowed by CART_TEST_ALLOW_MISSING"


def wiki_missing_allowed(env=os.environ) -> bool:
    names = {n.strip() for n in env.get("CART_TEST_ALLOW_MISSING", "").split(",")}
    return "wiki" in names or "all" in names


def wiki_checkout_present(wiki_dir: Path, env=os.environ) -> bool:
    """True when the wiki is checked out; False when it is absent and that is
    allowed (the caller skips). Raises when it is absent and not allowed."""
    if (Path(wiki_dir) / "Home.md").exists():
        return True
    if wiki_missing_allowed(env):
        return False
    raise AssertionError(
        f"No wiki checkout at {wiki_dir}: run `git submodule update --init CART.wiki`, "
        "or set CART_TEST_ALLOW_MISSING=wiki to skip the wiki checks."
    )
