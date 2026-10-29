"""A CVE-classified nuclei finding must reach the graph.

parse_nuclei_finding builds `cves` as {id, cvss, url} maps. The vuln writer
copied that list into `SET v += $props`, Neo4j refused it (properties hold only
primitives and arrays of them), and the per-finding `except` recorded an error
and moved on: every nuclei finding with a CVE classification was dropped.

The fixture the older writer tests use passes `cves` as plain strings, a shape
the parser never emits, which is why they stayed green. These tests feed the
writer what the parser really produces, through a session that enforces
Neo4j's property rule.

Run: ./CART.sh test unit   (recon section)
"""
import os
import sys
import unittest
from unittest.mock import MagicMock

_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

sys.modules.setdefault("neo4j", MagicMock())
sys.modules.setdefault("dotenv", MagicMock())

from graph_db.mixins.recon.vuln_mixin import VulnMixin, nuclei_cve_ids  # noqa: E402
from recon.helpers.nuclei_helpers import parse_nuclei_finding  # noqa: E402

HOST = "www.example.com"

_PRIMITIVES = (str, int, float, bool)


def _neo4j_storable(value) -> bool:
    if value is None or isinstance(value, _PRIMITIVES):
        return True
    if isinstance(value, (list, tuple)):
        return all(isinstance(v, _PRIMITIVES) for v in value)
    return False


class _Result:
    def single(self):
        return {"linked": 0, "count": 0, "c": 0}

    def __iter__(self):
        return iter([])


class _StrictSession:
    """Rejects a `props` map Neo4j would reject, as the real driver does."""

    def __init__(self, writes):
        self.writes = writes

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def run(self, query, **kwargs):
        props = kwargs.get("props")
        if isinstance(props, dict):
            bad = sorted(k for k, v in props.items() if not _neo4j_storable(v))
            if bad:
                raise TypeError(f"Property values can only be of primitive types or arrays thereof: {bad}")
        self.writes.append((query, kwargs))
        return _Result()


class _Client(VulnMixin):
    def __init__(self):
        self.writes = []
        self.driver = MagicMock()
        self.driver.session.side_effect = lambda: _StrictSession(self.writes)


def _raw_nuclei_line(**classification):
    return {
        "template-id": "CVE-2021-44228",
        "template": "http/cves/2021/CVE-2021-44228.yaml",
        "info": {
            "name": "Apache Log4j2 Remote Code Injection",
            "severity": "critical",
            "tags": ["cve", "rce", "log4j"],
            "classification": classification,
        },
        "type": "http",
        "host": HOST,
        "matched-at": f"https://{HOST}/",
        "ip": "192.0.2.10",
        "timestamp": "2026-09-24T08:00:00Z",
    }


def _recon(parsed):
    return {
        "domain": "example.com",
        "subdomains": [HOST],
        "vuln_scan": {"scan_metadata": {}, "discovered_urls": {},
                      "by_target": {HOST: {"findings": [parsed]}}},
    }


def _vuln_props(client):
    return [kw["props"] for q, kw in client.writes if "MERGE (v:Vulnerability" in q]


class TestCveClassifiedNucleiFinding(unittest.TestCase):

    def test_cve_nuclei_finding_dropped(self):
        parsed = parse_nuclei_finding(_raw_nuclei_line(**{"cve-id": ["CVE-2021-44228"], "cvss-score": 10.0}))
        self.assertIsInstance(parsed["cves"][0], dict, "the parser's shape this test guards against")

        client = _Client()
        stats = client.update_graph_from_vuln_scan(_recon(parsed), "u1", "p1")

        self.assertEqual(stats["errors"], [])
        self.assertEqual(stats["vulnerabilities_created"], 1)
        [props] = _vuln_props(client)
        self.assertEqual(props["cves"], ["CVE-2021-44228"])
        self.assertEqual(props["cvss_score"], 10.0)

    def test_both_classification_forms_write_each_id_once(self):
        parsed = parse_nuclei_finding(_raw_nuclei_line(**{
            "cve-id": "CVE-2021-44228", "cve": ["CVE-2021-44228", "CVE-2021-45046"],
        }))
        client = _Client()
        client.update_graph_from_vuln_scan(_recon(parsed), "u1", "p1")
        [props] = _vuln_props(client)
        self.assertEqual(props["cves"], ["CVE-2021-44228", "CVE-2021-45046"])

    def test_finding_without_cve_writes_an_empty_list(self):
        parsed = parse_nuclei_finding(_raw_nuclei_line())
        client = _Client()
        stats = client.update_graph_from_vuln_scan(_recon(parsed), "u1", "p1")
        self.assertEqual(stats["errors"], [])
        [props] = _vuln_props(client)
        self.assertEqual(props["cves"], [])

    def test_lowercase_cve_id_list_reaches_the_graph(self):
        # Nuclei v3's real JSONL: classification.cve-id is a LOWERCASE list. A
        # case-sensitive "CVE-" test dropped every CVE at parse time, so the
        # graph's has_cve / cve_year / cve_ids filters never saw a nuclei CVE.
        parsed = parse_nuclei_finding(_raw_nuclei_line(**{"cve-id": ["cve-2021-41773"], "cvss-score": 7.5}))
        self.assertEqual([c["id"] for c in parsed["cves"]], ["CVE-2021-41773"])
        client = _Client()
        client.update_graph_from_vuln_scan(_recon(parsed), "u1", "p1")
        [props] = _vuln_props(client)
        self.assertEqual(props["cves"], ["CVE-2021-41773"])


class TestNucleiCveIds(unittest.TestCase):

    def test_maps_are_reduced_to_their_id(self):
        self.assertEqual(
            nuclei_cve_ids([{"id": "CVE-2024-1", "cvss": 9.8, "url": "u"}, {"id": "CVE-2024-2"}]),
            ["CVE-2024-1", "CVE-2024-2"])

    def test_plain_ids_pass_through(self):
        self.assertEqual(nuclei_cve_ids(["CVE-2024-1"]), ["CVE-2024-1"])

    def test_duplicates_and_empty_entries_are_dropped(self):
        self.assertEqual(
            nuclei_cve_ids([{"id": "CVE-2024-1"}, "CVE-2024-1", {"id": ""}, {"cvss": 5.0}, None, ""]),
            ["CVE-2024-1"])

    def test_missing_list_is_empty(self):
        self.assertEqual(nuclei_cve_ids(None), [])


if __name__ == "__main__":
    unittest.main()
