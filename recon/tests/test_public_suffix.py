"""recon/helpers/public_suffix.py against the vectors the webapp's tldts helper
also reads (webapp/src/lib/publicSuffix.test.ts). A red vector here means the
pinned publicsuffixlist groups a stable name differently from tldts."""
import json
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO))

from recon.helpers import public_suffix as ps  # noqa: E402

_VECTORS = json.loads(
    (Path(__file__).parent / 'fixtures' / 'public_suffix_vectors.json').read_text())['vectors']


@pytest.mark.parametrize('v', _VECTORS, ids=[v['host'] for v in _VECTORS])
def test_vector(v):
    assert ps.org_domain(v['host']) == v['org']
    assert ps.public_suffix(v['host']) == v['publicSuffix']
    assert ps.is_public_suffix(v['host']) is (v['org'] is None)


def test_the_webapp_reads_the_same_vectors_file():
    ts = _REPO / 'webapp' / 'src' / 'lib' / 'publicSuffix.test.ts'
    if not ts.exists():
        pytest.skip('webapp source not mounted in this image')
    assert "'public_suffix_vectors.json'" in ts.read_text()


@pytest.mark.parametrize('ip', ['104.16.1.1', '192.0.2.10', '2001:db8::1', '[2001:db8::1]'])
def test_an_ip_literal_has_no_org_and_is_no_suffix(ip):
    # A last-two-labels rule made 104.16.1.1 the "domain" 1.1.
    assert ps.org_domain(ip) is None
    assert ps.public_suffix(ip) is None
    assert ps.is_public_suffix(ip) is False


def test_the_ip_mode_root_is_its_own_org():
    assert ps.org_domain('ip-targets.cmabc123') == 'ip-targets.cmabc123'
    assert ps.is_public_suffix('ip-targets.cmabc123') is False


@pytest.mark.parametrize('raw,org', [
    ('WWW.Acme.CO.UK', 'acme.co.uk'),
    ('www.acme.co.uk.', 'acme.co.uk'),
    ('  api.example.com ', 'example.com'),
])
def test_names_are_normalised_before_the_lookup(raw, org):
    assert ps.org_domain(raw) == org


@pytest.mark.parametrize('name', ['', '   ', None, 'localhost'])
def test_an_empty_or_single_unknown_label_has_no_org(name):
    assert ps.org_domain(name) is None


def test_the_version_is_the_pinned_one():
    pinned = next(
        line.split('==')[1].split()[0]
        for line in (_REPO / 'recon' / 'requirements.txt').read_text().splitlines()
        if line.startswith('publicsuffixlist=='))
    assert ps.psl_version() == pinned
