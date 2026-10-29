"""The full pipeline hands the whole batch's roots to the graph writers.

run_domain_group scans one group at a time, so recon_data["domain"] is the group
root. _stamp_project_roots adds recon_data["all_project_roots"] (every batch
root) so the writers attach a cross-root host to the right root. It is NOT
"domains", which would widen the per-group scan scope. A single-domain project
carries its one root, which is what attach_roots() falls back to anyway.

Fixture roots are alpha.test / beta.test / gamma.test only.
"""
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import recon.main as main  # noqa: E402
from recon.helpers import circuit_breaker  # noqa: E402

ROOTS = ["alpha.test", "beta.test", "gamma.test"]
GROUPS = [{"scanRoot": r, "orgDomain": r, "mode": "enumerate", "includeRoot": False,
           "exactHosts": []} for r in ROOTS]
BATCH = {"DOMAIN_BATCH_MODE": True, "SCOPE_GROUPS": GROUPS}


@pytest.fixture(autouse=True)
def _fresh_run_caches():
    # The ownership answers are cached per run, i.e. per process.
    circuit_breaker.reset_registry()
    yield
    circuit_breaker.reset_registry()


@pytest.fixture
def batch_settings(monkeypatch):
    monkeypatch.setattr(main, "_settings", dict(BATCH))
    monkeypatch.setattr(main, "VERIFY_DOMAIN_OWNERSHIP", False)
    monkeypatch.setattr(main, "_BATCH_ATTACH_ROOTS", main._eligible_batch_roots(GROUPS))


@pytest.fixture
def single_settings(monkeypatch):
    monkeypatch.setattr(main, "_settings", {"DOMAIN_BATCH_MODE": False})


def test_every_scanned_root_is_attachable(batch_settings):
    assert main._eligible_batch_roots(GROUPS) == ROOTS


def test_a_refused_root_is_not_attachable_or_seeded(monkeypatch):
    """Bug: all_project_roots and the Domain seeding took EVERY batch root, so a
    host found under a root the group run refuses (RoE-excluded, or failing
    ownership) became an in-scope Subdomain instead of an ExternalDomain."""
    settings = dict(BATCH, ROE_ENABLED=True, ROE_EXCLUDED_HOSTS=["beta.test"])
    monkeypatch.setattr(main, "_settings", settings)
    monkeypatch.setattr(main, "VERIFY_DOMAIN_OWNERSHIP", True)
    monkeypatch.setattr(main, "verify_domain_ownership",
                        lambda root, token, prefix: {"verified": root != "gamma.test",
                                                     "record_name": f"{prefix}.{root}"})
    assert main._eligible_batch_roots(GROUPS) == ["alpha.test"]


def test_an_ownership_check_that_errors_fails_closed(monkeypatch):
    monkeypatch.setattr(main, "_settings", dict(BATCH))
    monkeypatch.setattr(main, "VERIFY_DOMAIN_OWNERSHIP", True)

    def boom(*a):
        raise OSError("dns down")

    monkeypatch.setattr(main, "verify_domain_ownership", boom)
    assert main._eligible_batch_roots(GROUPS) == []


def test_stamp_adds_all_project_roots_in_batch_mode(batch_settings):
    recon_data = {"domain": "alpha.test"}
    main._stamp_project_roots(recon_data)
    assert recon_data["all_project_roots"] == ROOTS
    # The scan scope stays the group root: "domains" is never set here.
    assert "domains" not in recon_data


def test_a_single_domain_project_carries_its_own_root(monkeypatch):
    monkeypatch.setattr(main, "_settings", {"DOMAIN_BATCH_MODE": False, "SCOPE_GROUPS": GROUPS[:1]})
    recon_data = {"domain": "alpha.test"}
    main._stamp_project_roots(recon_data)
    assert recon_data["all_project_roots"] == ["alpha.test"]
    assert recon_data["scope_groups"] == [{"scan_root": "alpha.test", "org_domain": "alpha.test",
                                           "mode": "enumerate", "include_root": False, "exact_hosts": []}]


def test_no_target_means_no_roots(single_settings):
    recon_data = {"domain": ""}
    main._stamp_project_roots(recon_data)
    assert "all_project_roots" not in recon_data and recon_data["scope_groups"] == []


def test_stamp_returns_the_same_dict(batch_settings):
    recon_data = {"domain": "alpha.test"}
    assert main._stamp_project_roots(recon_data) is recon_data


def _graph_module(monkeypatch, client):
    from unittest.mock import MagicMock
    client.__enter__ = MagicMock(return_value=client)
    client.__exit__ = MagicMock(return_value=False)
    module = MagicMock()
    module.Neo4jClient.return_value = client
    monkeypatch.setitem(sys.modules, "graph_db", module)


def test_the_batch_restores_every_roots_domain_node_before_group_1(monkeypatch):
    from unittest.mock import MagicMock
    client = MagicMock()
    client.verify_connection.return_value = True
    client.ensure_root_domains.return_value = 3
    _graph_module(monkeypatch, client)
    monkeypatch.setattr(main, "UPDATE_GRAPH_DB", True)
    monkeypatch.setattr(main, "USER_ID", "u1")
    monkeypatch.setattr(main, "PROJECT_ID", "p1")
    main._seed_batch_root_domains(ROOTS)
    client.ensure_root_domains.assert_called_once_with(ROOTS, "u1", "p1")


def test_a_seeding_failure_never_fails_the_scan(monkeypatch):
    from unittest.mock import MagicMock
    client = MagicMock()
    client.verify_connection.return_value = True
    client.ensure_root_domains.side_effect = RuntimeError("neo4j down")
    _graph_module(monkeypatch, client)
    monkeypatch.setattr(main, "UPDATE_GRAPH_DB", True)
    main._seed_batch_root_domains(ROOTS)   # must not raise


def test_seeding_happens_before_the_first_group(monkeypatch, tmp_path):
    order = []
    monkeypatch.setattr(main, "_settings", dict(BATCH))
    monkeypatch.setattr(main, "VERIFY_DOMAIN_OWNERSHIP", False)
    monkeypatch.setattr(main, "_seed_batch_root_domains", lambda roots: order.append(("seed", roots)))
    monkeypatch.setattr(main, "run_domain_group",
                        lambda group, start_time=None: order.append(group["scanRoot"]) or 0)
    monkeypatch.setattr(main, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(main, "merge_batch_outputs", lambda *a, **k: None)
    from datetime import datetime
    main.run_domain_batch(GROUPS, start_time=datetime.now())
    assert order == [("seed", ROOTS)] + ROOTS


class TestOwnership:
    """§4.8: the scan root or the registrable domain may hold the token; each
    name is asked once per run; a resolver failure fails closed."""

    GROUP = {"scanRoot": "api.alpha.test", "orgDomain": "alpha.test", "mode": "enumerate",
             "includeRoot": False, "exactHosts": []}

    def _verify(self, monkeypatch, answers):
        calls = []

        def fake(name, token, prefix):
            calls.append(name)
            return dict(answers[name], record_name=f"{prefix}.{name}", expected_value="CART-verify=t")
        monkeypatch.setattr(main, "verify_domain_ownership", fake)
        return calls

    def test_the_org_record_passes_a_deeper_root(self, monkeypatch):
        calls = self._verify(monkeypatch, {"api.alpha.test": {"verified": False, "error": "No TXT"},
                                           "alpha.test": {"verified": True}})
        assert main._group_ownership(self.GROUP)["verified"] is True
        assert calls == ["api.alpha.test", "alpha.test"]

    def test_each_name_is_asked_once_per_run(self, monkeypatch):
        calls = self._verify(monkeypatch, {"api.alpha.test": {"verified": False, "error": "No TXT"},
                                           "www.alpha.test": {"verified": False, "error": "No TXT"},
                                           "alpha.test": {"verified": False, "error": "No TXT"}})
        main._group_ownership(self.GROUP)
        main._group_ownership(dict(self.GROUP, scanRoot="www.alpha.test"))
        assert calls.count("alpha.test") == 1

    def test_a_resolver_failure_fails_closed_and_is_not_cached(self, monkeypatch):
        calls = self._verify(monkeypatch, {"api.alpha.test": {"verified": False, "resolver_failed": True,
                                                              "error": "DNS resolver down"}})
        out = main._group_ownership(self.GROUP)
        assert out["verified"] is False and "resolver down" in out["error"]
        assert calls == ["api.alpha.test"]          # the org is not tried
        main._group_ownership(self.GROUP)
        assert calls == ["api.alpha.test"] * 2      # and the failure was not cached

    def test_the_failure_names_both_records(self, monkeypatch):
        self._verify(monkeypatch, {"api.alpha.test": {"verified": False, "error": "No TXT"},
                                   "alpha.test": {"verified": False, "error": "No TXT"}})
        monkeypatch.setattr(main, "OWNERSHIP_TXT_PREFIX", "_CART-verify")
        out = main._group_ownership(self.GROUP)
        assert out["record_names"] == ["_CART-verify.api.alpha.test", "_CART-verify.alpha.test"]
