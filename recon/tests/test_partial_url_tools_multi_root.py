"""Partial URL-driven tools over several roots.

Crawlers, fuzzers, JS analysis, GraphQL and cache-poisoning scans read BaseURLs
and Endpoints project-wide. Over a Domain batch they now:

  - keep a URL under ANY of the run's roots (JS recon's scope used one root);
  - drop a URL whose host sits under a Domain the run does not cover (a root
    removed from the batch, or one the operator left unticked);
  - drop a host a literal batch group never listed;
  - classify a host JS recon finds under another root as in scope, not external.

Fixture roots are alpha.test / beta.test / gamma.test only.
"""
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from recon.partial_recon_modules import helpers, parameter_discovery, web_crawling  # noqa: E402
from recon.partial_recon_modules.helpers import _scope_partial_urls  # noqa: E402

ROOTS = ["alpha.test", "beta.test", "gamma.test"]
GROUPS = [
    {"rootDomain": "alpha.test", "prefixes": ["www.", "."], "batch": True},
    {"rootDomain": "beta.test", "prefixes": ["*"], "batch": True},
    {"rootDomain": "gamma.test", "prefixes": ["*"], "batch": True},
]
BASE = {"_settings": {}, "domains": ROOTS, "domain": ROOTS[0], "domain_groups": GROUPS}


class TestScopePartialUrls:
    URLS = [
        "https://www.alpha.test/app.js",
        "https://alpha.test/main.js",           # included apex
        "https://san-only.alpha.test/x.js",     # literal, unlisted
        "https://cdn.beta.test/b.js",
        "https://beta.test/a.js",               # excluded apex
        "https://www.old.test/o.js",            # a stale root
        "https://cdn.thirdparty.example/t.js",
    ]

    def test_multi_root_scope(self):
        urls, hosts = _scope_partial_urls(self.URLS, [], [], {}, ROOTS, domain_groups=GROUPS)
        assert urls == ["https://www.alpha.test/app.js", "https://alpha.test/main.js",
                        "https://cdn.beta.test/b.js"]
        assert set(hosts) == {"www.alpha.test", "alpha.test", "cdn.beta.test"}

    def test_typed_urls_are_kept_as_before(self):
        urls, _ = _scope_partial_urls([], ["https://cdn.thirdparty.example/t.js"], [], {}, ROOTS,
                                      domain_groups=GROUPS)
        assert urls == ["https://cdn.thirdparty.example/t.js"]

    def test_graph_subdomains_follow_the_same_scope(self):
        _, hosts = _scope_partial_urls([], [], ["api.gamma.test", "san-only.alpha.test", "x.old.test"],
                                       {}, ROOTS, domain_groups=GROUPS)
        assert hosts == ["api.gamma.test"]

    def test_the_single_root_form_is_unchanged(self):
        urls, _ = _scope_partial_urls(self.URLS, [], [], {"SUBDOMAIN_LIST": []}, "alpha.test")
        assert urls == ["https://www.alpha.test/app.js", "https://san-only.alpha.test/x.js"]


class TestJsReconClassification:
    def test_a_host_under_another_root_is_in_scope_not_external(self):
        from recon.main_recon_modules.js_recon import _extract_subdomains
        endpoints = [{"full_url": "https://api.beta.test/v1"}, {"full_url": "https://x.other.example/"}]
        new, external = _extract_subdomains(endpoints, ROOTS, set())
        assert new == ["api.beta.test"]
        assert [e["domain"] for e in external] == ["x.other.example"]

    def test_the_single_root_form_is_unchanged(self):
        from recon.main_recon_modules.js_recon import _extract_subdomains
        new, external = _extract_subdomains([{"full_url": "https://api.beta.test/v1"}], "alpha.test", set())
        assert new == [] and [e["domain"] for e in external] == ["api.beta.test"]

    def test_merge_accepts_several_roots(self, monkeypatch):
        from recon.helpers import target_helpers
        monkeypatch.setattr(target_helpers, "_resolves_to_routable", lambda name: True)
        result = target_helpers.merge_discovered_hostnames(
            {"dns": {"subdomains": {}}}, ["api.beta.test", "x.other.example"], "js_recon",
            root_domain=ROOTS)
        assert "api.beta.test" in result["dns"]["subdomains"]
        assert [e["domain"] for e in result["discovered_external_domains"]] == ["x.other.example"]

    def test_merge_still_fails_closed_without_a_root(self):
        from recon.helpers import target_helpers
        result = target_helpers.merge_discovered_hostnames({}, ["api.beta.test"], "js_recon", root_domain=[])
        assert result["discovered_external_domains"] == [{"domain": "api.beta.test", "source": "js_recon"}]


# --- module wiring ------------------------------------------------------------------

class _Session:
    def __init__(self, rows_for):
        self.rows_for = rows_for

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def run(self, cypher, **params):
        result = MagicMock()
        rows = self.rows_for(cypher, params)
        result.__iter__ = lambda s: iter(rows)
        result.single.return_value = rows[0] if rows else None
        return result


def _graph(monkeypatch, rows_for):
    client = MagicMock()
    client.verify_connection.return_value = True
    client.__enter__ = MagicMock(return_value=client)
    client.__exit__ = MagicMock(return_value=False)
    client.driver.session.side_effect = lambda: _Session(rows_for)
    for method in ("update_graph_from_resource_enum",):
        getattr(client, method).return_value = {}
    module = MagicMock()
    module.Neo4jClient.return_value = client
    monkeypatch.setitem(sys.modules, "graph_db", module)
    return client


def _url_rows(cypher, params):
    """Endpoints and BaseURLs across two current roots and a stale one."""
    if "RETURN d.name AS name" in cypher:
        return [{"name": n} for n in ("alpha.test", "beta.test", "gamma.test", "old.test")]
    if "MATCH (e:Endpoint" in cypher:
        return [{"url": "https://www.alpha.test/a.js"}, {"url": "https://www.old.test/o.js"},
                {"url": "https://shop.gamma.test/g.js"}]
    if "MATCH (b:BaseURL" in cypher:
        return [{"url": "https://api.beta.test", "host": "api.beta.test"},
                {"url": "https://www.old.test", "host": "www.old.test"}]
    if "collect(DISTINCT s.name)" in cypher:
        return [{"subdomains": ["www.alpha.test"]}]
    return []


class TestJsluiceAndArjunTargets:
    def test_jsluice_drops_the_stale_roots_urls_and_scans_every_current_root(self, monkeypatch):
        _graph(monkeypatch, _url_rows)
        seen = {}

        def fake_jsluice(urls, *a, **kw):
            seen["urls"] = list(urls)
            return {}, [], {"jsluice_total": 0, "jsluice_new": 0}, []

        with patch("recon.helpers.resource_enum.run_jsluice_analysis", side_effect=fake_jsluice, create=True), \
             patch("recon.helpers.resource_enum.merge_jsluice_into_by_base_url",
                   side_effect=lambda *a, **kw: ({}, {"jsluice_total": 0, "jsluice_new": 0}), create=True), \
             patch("recon.helpers.resource_enum.verify_jsluice_urls", side_effect=lambda urls, *a, **kw: urls,
                   create=True):
            try:
                web_crawling.run_jsluice(dict(BASE))
            except Exception:
                pass
        urls = seen.get("urls") or []
        assert "https://www.old.test/o.js" not in urls and "https://www.old.test" not in urls
        assert {"https://www.alpha.test/a.js", "https://shop.gamma.test/g.js", "https://api.beta.test"} <= set(urls)

    def test_arjun_drops_the_stale_roots_urls(self, monkeypatch):
        _graph(monkeypatch, _url_rows)
        seen = {}

        def fake_arjun(urls, *a, **kw):
            seen["urls"] = list(urls)
            return {}, {"arjun_params_discovered": 0, "arjun_endpoints_tested": 0}

        with patch("recon.helpers.resource_enum.arjun_helpers.run_arjun_discovery", side_effect=fake_arjun):
            try:
                parameter_discovery.run_arjun(dict(BASE))
            except Exception:
                pass
        urls = seen.get("urls") or []
        assert urls, "arjun was never called with targets"
        assert not any("old.test" in u for u in urls)


class TestBuilderCallers:
    @pytest.mark.parametrize("runner", ["run_katana", "run_hakrawler", "run_ffuf"])
    def test_crawlers_hand_every_root_and_group_to_the_builder(self, monkeypatch, runner):
        _graph(monkeypatch, lambda c, p: [])
        builder = MagicMock(return_value={
            "domain": "alpha.test", "domains": ROOTS, "subdomains": [],
            "dns": {"domain": {"ips": {"ipv4": [], "ipv6": []}, "has_records": False}, "subdomains": {}},
            "http_probe": {"by_url": {}}, "metadata": {"include_root_domain": False},
        })
        monkeypatch.setattr(web_crawling, "_build_http_probe_data_from_graph", builder)
        with pytest.raises(SystemExit):   # nothing to crawl: the tool stops after building
            getattr(web_crawling, runner)(dict(BASE))
        assert builder.call_args.args[0] == ROOTS
        assert builder.call_args.kwargs["domain_groups"] == GROUPS

    def test_kiterunner_hands_every_root_to_the_builder(self, monkeypatch):
        _graph(monkeypatch, lambda c, p: [])
        builder = MagicMock(return_value={
            "domain": "alpha.test", "domains": ROOTS, "subdomains": [],
            "dns": {"domain": {"ips": {"ipv4": [], "ipv6": []}, "has_records": False}, "subdomains": {}},
            "http_probe": {"by_url": {}}, "metadata": {"include_root_domain": False},
        })
        monkeypatch.setattr(parameter_discovery, "_build_http_probe_data_from_graph", builder)
        with pytest.raises(SystemExit):
            parameter_discovery.run_kiterunner(dict(BASE))
        assert builder.call_args.args[0] == ROOTS
        assert builder.call_args.kwargs["domain_groups"] == GROUPS

    def test_zap_filters_graph_urls_under_any_root(self, monkeypatch):
        _graph(monkeypatch, lambda c, p: [])
        builder = MagicMock(return_value={
            "domain": "alpha.test", "domains": ROOTS, "subdomains": [],
            "dns": {"domain": {"ips": {"ipv4": [], "ipv6": []}, "has_records": False}, "subdomains": {}},
            "http_probe": {"by_url": {
                "https://api.beta.test": {"url": "https://api.beta.test", "host": "api.beta.test",
                                          "status_code": 200},
                "https://x.other.example": {"url": "https://x.other.example", "host": "x.other.example",
                                            "status_code": 200},
            }},
            "metadata": {"include_root_domain": False},
        })
        monkeypatch.setattr(web_crawling, "_build_http_probe_data_from_graph", builder)
        seen = {}
        with patch("recon.helpers.resource_enum.run_zap_ajax_spider",
                   side_effect=lambda urls, *a, **kw: (seen.setdefault("urls", list(urls)), ([], {}))[1]), \
             patch("recon.helpers.resource_enum.pull_zap_ajax_docker_image", return_value=True):
            try:
                web_crawling.run_zap_ajax_spider_partial(dict(BASE))
            except Exception:
                pass
        urls = seen.get("urls") or []
        assert any("api.beta.test" in u for u in urls)
        assert not any("x.other.example" in u for u in urls)
