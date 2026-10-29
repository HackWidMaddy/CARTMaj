"""
The Public Suffix List, the one place recon asks it.

The webapp's mirror is webapp/src/lib/publicSuffix.ts (tldts); both read
tests/fixtures/public_suffix_vectors.json, so a version bump that changes how a
stable name groups turns a test red on both sides. The private section is on:
without it `alice.github.io` would report the org `github.io` and `*.github.io`
would pass as an enumerable root.

publicsuffixlist ships its list inside the wheel and never downloads it, so the
answers depend only on the pinned version (bump it with tldts, README.DEV.md 5.8).
An import failure is deliberately NOT caught here: the settings loader turns it
into a refused run, because guessing would either enumerate a suffix or quietly
narrow the scope.
"""
import ipaddress
from importlib.metadata import PackageNotFoundError, version

from publicsuffixlist import PublicSuffixList

_PSL = PublicSuffixList(accept_unknown=True)

# The root an IP-mode run writes in place of a domain (recon/main.py run_ip_recon).
_IP_MODE_ROOT_PREFIX = 'ip-targets.'


def psl_version() -> str:
    try:
        return version('publicsuffixlist')
    except PackageNotFoundError:
        return 'unknown'


def _clean(name: str) -> str:
    return str(name or '').strip().lower().rstrip('.')


def _is_ip(name: str) -> bool:
    try:
        ipaddress.ip_address(name.strip('[]'))
    except ValueError:
        return False
    return True


def org_domain(host: str) -> str | None:
    """The registrable domain `host` belongs to, or None for an IP literal, a
    public suffix (`co.uk`, `github.io`, `com`) or an empty name.

    An unknown TLD counts as a one-label suffix, so lab and test names keep
    working (`a.example.test` -> `example.test`). The IP-mode root is its own org.
    """
    name = _clean(host)
    if not name or _is_ip(name):
        return None
    if name.startswith(_IP_MODE_ROOT_PREFIX):
        return name
    return _PSL.privatesuffix(name)


def is_public_suffix(name: str) -> bool:
    """True when `name` itself is a public suffix, so `*.<name>` would enumerate
    every registrant under it. An IP literal or the IP-mode root is not one."""
    clean = _clean(name)
    if not clean or _is_ip(clean) or clean.startswith(_IP_MODE_ROOT_PREFIX):
        return False
    return _PSL.privatesuffix(clean) is None


def public_suffix(host: str) -> str | None:
    """The public suffix of `host` (`www.acme.co.uk` -> `co.uk`), or None for
    an IP literal or an empty name."""
    name = _clean(host)
    if not name or _is_ip(name):
        return None
    return _PSL.publicsuffix(name)
