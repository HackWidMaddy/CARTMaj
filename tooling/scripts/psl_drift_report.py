#!/usr/bin/env python3
"""Compare the two pinned Public Suffix List snapshots: recon's and the webapp's.

    python3 tooling/scripts/psl_drift_report.py [--dat path/to/public_suffix_list.dat]

Recon decides "never enumerate a public suffix" with `publicsuffixlist` (pinned in
recon/requirements.txt); the webapp groups and validates with `tldts` (pinned in
webapp/package.json). Both ship a frozen copy of the list, so they drift apart as
the registries add suffixes. This lists every rule of recon's bundled copy and
asks the webapp's tldts whether it agrees:

  - a plain rule `x`         must be a public suffix (no registrable domain);
  - a wildcard rule `*.x`    must make `<label>.x` a public suffix;
  - an exception rule `!y.x` must make `y.x` registrable.

Informational: run it at release time (docs/readmes/README.DEV.md). A non-empty
report means bumping the older side, both pins in the same commit. By default the
.dat comes from the built recon image; the host needs node and webapp/node_modules.
Exit 0 always; prints the disagreements and a count.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

_EXTRACT = (
    "import os, publicsuffixlist; "
    "d = os.path.dirname(publicsuffixlist.__file__); "
    "print(open(os.path.join(d, 'public_suffix_list.dat'), encoding='utf-8').read())"
)

# Reads names on stdin, prints {name: getDomain(name)} with the private section on.
_NODE = (
    "const t = require('tldts'); const rl = require('fs').readFileSync(0, 'utf8').split('\\n').filter(Boolean);"
    "const out = {}; for (const n of rl) out[n] = t.getDomain(n, { allowPrivateDomains: true });"
    "process.stdout.write(JSON.stringify(out))"
)


def _ascii(rule: str) -> str:
    """The rule in the punycode form tldts compares; markers kept as they are."""
    marker = '!' if rule.startswith('!') else '*.' if rule.startswith('*.') else ''
    name = rule[len(marker):]
    try:
        return marker + name.encode('idna').decode('ascii')
    except UnicodeError:
        return rule


def load_rules(dat: str) -> list[str]:
    rules = []
    for line in dat.splitlines():
        line = line.strip()
        if line and not line.startswith('//'):
            rules.append(_ascii(line.split()[0]))
    return rules


def probes(rules: list[str]) -> dict[str, tuple[str, bool]]:
    """name -> (rule, expected_registrable)."""
    out: dict[str, tuple[str, bool]] = {}
    for r in rules:
        if r.startswith('!'):
            out[r[1:]] = (r, True)
        elif r.startswith('*.'):
            out[f'drift-probe.{r[2:]}'] = (r, False)
        else:
            out[r] = (r, False)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--dat', type=Path, help="a public_suffix_list.dat; default: the one in the recon image")
    ap.add_argument('--image', default='CART-recon:latest')
    a = ap.parse_args()

    if a.dat:
        dat = a.dat.read_text(encoding='utf-8')
    else:
        dat = subprocess.run(['docker', 'run', '--rm', '--entrypoint', 'python3', a.image, '-c', _EXTRACT],
                             capture_output=True, text=True, check=True).stdout
    names = probes(load_rules(dat))
    answers = json.loads(subprocess.run(
        ['node', '-e', _NODE], input='\n'.join(names), capture_output=True, text=True, check=True,
        cwd=REPO / 'webapp').stdout)

    drift = []
    for name, (rule, registrable) in sorted(names.items()):
        got = answers.get(name) is not None and answers.get(name) == name if registrable else answers.get(name) is None
        if not got:
            drift.append(f'{rule:40s} tldts says {name} -> {answers.get(name)}')
    for line in drift:
        print(line)
    print(f'{len(drift)} of {len(names)} rules disagree between publicsuffixlist and tldts')
    return 0


if __name__ == '__main__':
    sys.exit(main())
