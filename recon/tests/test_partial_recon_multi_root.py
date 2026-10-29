"""Partial recon over several project roots: the container side.

The orchestrator picks the roots (config["domains"]); partial_recon.main then
re-checks each one against the container's OWN settings, exactly as
run_domain_group does per group (RoE excluded host, domain ownership), strips
any settings override outside the allowlist, and ends every run with a report
whose exit code says whether anything ran. run_per_root keeps one failing root
from ending a per-root API loop.

Fixture roots are alpha.test / beta.test / gamma.test only.
"""
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from recon.partial_recon_modules import helpers as h  # noqa: E402
from recon.partial_recon_modules.helpers import (  # noqa: E402
    STATUS_NO_RESULTS,
    STATUS_OK,
    STATUS_RATE_LIMITED,
    _is_host_in_scope,
    allowed_hosts_for,
    host_in_roots,
    include_root_for,
    partial_domain_groups,
    root_for_host,
    run_exit_code,
    run_per_root,
    scope_roots,
    settings_project_roots,
)

BATCH_GROUPS = [
    {"rootDomain": "alpha.test", "prefixes": ["www.", "api.", "."]},
    {"rootDomain": "beta.test", "prefixes": ["*"]},
    {"rootDomain": "gamma.test", "prefixes": ["*", "."]},
]


def _dispatched_tools() -> set:
    """Every tool the real dispatcher routes, read from its source so the
    'every tool gets every root' check follows the tools actually shipped."""
    import re
    return set(re.findall(r'tool_id == "([A-Za-z]+)"',
                          (PROJECT_ROOT / "recon" / "partial_recon.py").read_text()))


PARTIAL_TOOLS = _dispatched_tools()
BATCH_SETTINGS = {
    "DOMAIN_BATCH_MODE": True, "DOMAIN_BATCH_GROUPS": BATCH_GROUPS,
    "TARGET_DOMAIN": "", "SUBDOMAIN_LIST": [], "IP_MODE": False,
}
GROUPS = [dict(g, batch=True) for g in BATCH_GROUPS]


# --- scope helpers --------------------------------------------------------------

class TestScopeRoots:
    def test_domains_list_wins(self):
        assert scope_roots({"domains": ["alpha.test", "beta.test"], "domain": "alpha.test"}) \
            == ["alpha.test", "beta.test"]

    def test_legacy_single_domain(self):
        assert scope_roots({"domain": "alpha.test"}) == ["alpha.test"]

    def test_nothing(self):
        assert scope_roots({}) == []
        assert scope_roots({"domains": [], "domain": ""}) == []


class TestRootForHost:
    ROOTS = ["alpha.test", "beta.test", "gamma.test"]

    @pytest.mark.parametrize("host,root", [
        ("www.alpha.test", "alpha.test"),
        ("alpha.test", "alpha.test"),
        ("deep.api.beta.test", "beta.test"),
        ("WWW.Gamma.Test.", "gamma.test"),
        ("alpha.test.evil", None),
        ("notalpha.test", None),
        ("", None),
    ])
    def test_matches_on_label_boundaries(self, host, root):
        assert root_for_host(host, self.ROOTS) == root

    def test_the_longest_root_wins(self):
        assert root_for_host("x.api.alpha.test", ["alpha.test", "api.alpha.test"]) == "api.alpha.test"

    def test_returns_the_stored_spelling(self):
        assert root_for_host("www.alpha.test", ["Alpha.test"]) == "Alpha.test"

    def test_ip_mode_maps_every_host_to_the_synthetic_root(self):
        assert root_for_host("192-0-2-10", ["ip-targets.p1"], ip_mode=True) == "ip-targets.p1"
        assert root_for_host("", ["ip-targets.p1"], ip_mode=True) is None

    def test_host_in_roots(self):
        assert host_in_roots("a.beta.test", self.ROOTS)
        assert not host_in_roots("beta.test.example", self.ROOTS)


class TestGroupScope:
    def test_include_root_follows_each_groups_dot(self):
        assert include_root_for("alpha.test", GROUPS) is True
        assert include_root_for("beta.test", GROUPS) is False
        assert include_root_for("gamma.test", GROUPS) is True
        assert include_root_for("unknown.test", GROUPS) is False

    def test_a_literal_group_allows_exactly_its_hosts(self):
        assert allowed_hosts_for("alpha.test", GROUPS) == {"www.alpha.test", "api.alpha.test", "alpha.test"}

    def test_a_wildcard_group_allows_anything_under_it(self):
        assert allowed_hosts_for("beta.test", GROUPS) is None
        assert allowed_hosts_for("gamma.test", GROUPS) is None

    def test_a_single_project_is_never_narrowed(self):
        single = [{"rootDomain": "alpha.test", "prefixes": ["www."], "batch": False}]
        assert allowed_hosts_for("alpha.test", single) is None
        assert include_root_for("alpha.test", single) is False

    def test_single_project_apex_matches_the_old_rule(self):
        # _should_include_root_domain: any prefix that strips to empty.
        for prefixes, expected in ([], False), (["."], True), (["..."], True), (["*."], False):
            groups = [{"rootDomain": "alpha.test", "prefixes": prefixes, "batch": False}]
            assert include_root_for("alpha.test", groups) is expected
            assert h._should_include_root_domain({"SUBDOMAIN_LIST": prefixes}) is expected


class TestGroupsComeFromSettings:
    def test_batch_groups_for_the_run_roots_only(self):
        got = partial_domain_groups(BATCH_SETTINGS, ["beta.test", "alpha.test"])
        assert [g["rootDomain"] for g in got] == ["alpha.test", "beta.test"]
        assert all(g["batch"] for g in got)

    def test_a_wildcard_the_settings_demoted_stays_demoted(self):
        # _parse_domain_batch_groups strips '*' from a public-suffix root; the
        # partial run must see that literal group, not a wildcard from elsewhere.
        settings = dict(BATCH_SETTINGS, DOMAIN_BATCH_GROUPS=[
            {"rootDomain": "beta.test", "prefixes": ["www."]}])
        groups = partial_domain_groups(settings, ["beta.test"])
        assert allowed_hosts_for("beta.test", groups) == {"www.beta.test"}

    def test_single_project(self):
        # One scope group: no listed prefix, so it enumerates, with its root on.
        settings = {"TARGET_DOMAIN": "alpha.test", "SUBDOMAIN_LIST": ["."]}
        assert partial_domain_groups(settings, ["alpha.test"]) == [{
            "rootDomain": "alpha.test", "prefixes": ["*", "."], "batch": False,
            "scanRoot": "alpha.test", "orgDomain": "alpha.test", "mode": "enumerate",
            "includeRoot": True, "exactHosts": []}]

    def test_ip_mode_has_no_groups(self):
        assert partial_domain_groups({"IP_MODE": True}, ["ip-targets.p1"]) == []

    def test_project_roots_per_mode(self):
        assert settings_project_roots(BATCH_SETTINGS, "p1") == ["alpha.test", "beta.test", "gamma.test"]
        assert settings_project_roots({"TARGET_DOMAIN": " alpha.test "}, "p1") == ["alpha.test"]
        assert settings_project_roots({"IP_MODE": True}, "p1") == ["ip-targets.p1"]
        assert settings_project_roots({"TARGET_DOMAIN": ""}, "p1") == []


class TestHostInScopeUnderAnyRoot:
    ROOTS = ["alpha.test", "beta.test"]

    def test_a_subdomain_of_any_root(self):
        assert _is_host_in_scope("www.beta.test", {}, self.ROOTS, set())
        assert not _is_host_in_scope("www.gamma.test", {}, self.ROOTS, set())

    def test_the_apex_only_for_included_roots(self):
        assert _is_host_in_scope("alpha.test", {}, self.ROOTS, {"alpha.test"})
        assert not _is_host_in_scope("beta.test", {}, self.ROOTS, {"alpha.test"})

    def test_the_single_string_form_is_unchanged(self):
        assert _is_host_in_scope("www.alpha.test", {}, "alpha.test", False)
        assert not _is_host_in_scope("alpha.test", {}, "alpha.test", False)
        assert _is_host_in_scope("alpha.test", {}, "alpha.test", True)
        assert _is_host_in_scope("anything.example", {}, "", False)

    def test_ip_mode_branch_is_untouched(self):
        s = {"IP_MODE": True, "TARGET_IPS": ["192.0.2.10"]}
        assert _is_host_in_scope("192.0.2.10", s, ["ip-targets.p1"], set())
        assert not _is_host_in_scope("192.0.2.11", s, ["ip-targets.p1"], set())


# --- run_per_root -----------------------------------------------------------------

class TestRunPerRoot:
    def test_one_failing_root_never_stops_the_others(self):
        attempts = {"gamma.test": 0}

        def fn(root):
            if root == "alpha.test":
                raise RuntimeError("secret-key=abc123 in the URL")
            if root == "beta.test":
                sys.exit(1)
            if root == "gamma.test":
                attempts[root] += 1
                return STATUS_RATE_LIMITED
            return None

        with mock.patch.object(h.time, "sleep") as sleep:
            got = run_per_root(["alpha.test", "beta.test", "gamma.test", "delta.test"], fn, "Urlscan")

        assert got == {
            "alpha.test": "failed: RuntimeError",
            "beta.test": "failed: SystemExit",
            "gamma.test": STATUS_RATE_LIMITED,
            "delta.test": STATUS_OK,
        }
        assert attempts["gamma.test"] == 2          # retried exactly once
        waits = [c.args[0] for c in sleep.call_args_list]
        assert waits.count(h.RATE_LIMIT_RETRY_DELAY_S) == 1
        assert waits.count(h.ROOT_PAUSE_S) == 3      # between four roots
        assert run_exit_code(got) == 0

    def test_the_exception_text_is_never_recorded(self, capsys):
        def fn(root):
            raise ValueError("token=abc123")

        with mock.patch.object(h.time, "sleep"):
            got = run_per_root(["alpha.test"], fn, "Urlscan")
        assert "abc123" not in json.dumps(got)
        assert "abc123" not in capsys.readouterr().out

    def test_a_retry_that_succeeds_is_ok(self):
        calls = []

        def fn(root):
            calls.append(root)
            return STATUS_RATE_LIMITED if len(calls) == 1 else None

        with mock.patch.object(h.time, "sleep"):
            assert run_per_root(["alpha.test"], fn, "Urlscan") == {"alpha.test": STATUS_OK}

    def test_exit_code(self):
        assert run_exit_code({"a": STATUS_NO_RESULTS}) == 0
        assert run_exit_code({"a": "failed: X", "b": STATUS_RATE_LIMITED}) == 1
        assert run_exit_code({}) == 1


# --- partial_recon.main -----------------------------------------------------------

@pytest.fixture
def pr(monkeypatch):
    import recon.partial_recon as module
    monkeypatch.setenv("USER_ID", "u1")
    monkeypatch.setenv("PROJECT_ID", "p1")
    monkeypatch.setattr("recon.graph_db_preflight.require_graph_db", lambda *_: None)
    monkeypatch.setattr(module, "_cleanup_orphan_user_inputs", lambda *_: 0)
    # No graph here; test_partial_scope_groups.py covers the check itself.
    monkeypatch.setattr(module, "_legacy_graph_refusal", lambda settings, uid, pid: None)
    return module


def _run_main(pr, monkeypatch, config, settings, dispatch=None):
    """Run main() with this config and settings; return (exit_code, sweeps, dispatched)."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(config, f)
    monkeypatch.setenv("PARTIAL_RECON_CONFIG", f.name)
    monkeypatch.setattr(pr, "get_settings", lambda: dict(settings))
    sweeps, dispatched = [], []
    monkeypatch.setattr(pr, "_apply_node_filters", lambda started_at: sweeps.append(started_at))

    def _dispatch(tool_id, cfg):
        dispatched.append(dict(cfg))
        return dispatch(cfg) if dispatch else None

    monkeypatch.setattr(pr, "_dispatch", _dispatch)
    try:
        pr.main()
        code = 0
    except SystemExit as e:
        code = e.code
    finally:
        os.unlink(f.name)
    return code, sweeps, dispatched


class TestContainerRefusal:
    def test_an_roe_excluded_root_is_refused(self, pr, monkeypatch, capsys):
        settings = dict(BATCH_SETTINGS, ROE_ENABLED=True, ROE_EXCLUDED_HOSTS=["beta.test"])
        code, _, dispatched = _run_main(pr, monkeypatch, {
            "tool_id": "Urlscan", "domains": ["alpha.test", "beta.test"]}, settings)
        assert code == 0
        assert dispatched[0]["domains"] == ["alpha.test"]
        assert "beta.test: refused-roe" in capsys.readouterr().out

    def test_an_unverified_root_is_refused(self, pr, monkeypatch, capsys):
        settings = dict(BATCH_SETTINGS, VERIFY_DOMAIN_OWNERSHIP=True, OWNERSHIP_TOKEN="t")
        verified = {"alpha.test": True, "beta.test": False}
        with mock.patch("recon.main_recon_modules.domain_recon.verify_domain_ownership",
                        side_effect=lambda d, *a: {"verified": verified[d]}) as check:
            code, _, dispatched = _run_main(pr, monkeypatch, {
                "tool_id": "Urlscan", "domains": ["alpha.test", "beta.test"]}, settings)
        assert code == 0
        assert dispatched[0]["domains"] == ["alpha.test"]
        assert sorted(c.args[0] for c in check.call_args_list) == ["alpha.test", "beta.test"]
        assert "beta.test: refused-ownership" in capsys.readouterr().out

    def test_an_ownership_lookup_that_raises_fails_closed(self, pr, monkeypatch):
        settings = dict(BATCH_SETTINGS, VERIFY_DOMAIN_OWNERSHIP=True)
        with mock.patch("recon.main_recon_modules.domain_recon.verify_domain_ownership",
                        side_effect=OSError("dns down")):
            code, _, dispatched = _run_main(pr, monkeypatch, {
                "tool_id": "Urlscan", "domains": ["alpha.test"]}, settings)
        assert code == 1 and dispatched == []

    def test_ip_mode_skips_the_ownership_check(self, pr, monkeypatch):
        settings = {"IP_MODE": True, "VERIFY_DOMAIN_OWNERSHIP": True}
        with mock.patch("recon.main_recon_modules.domain_recon.verify_domain_ownership",
                        side_effect=AssertionError("checked")):
            code, _, dispatched = _run_main(pr, monkeypatch, {
                "tool_id": "Tlsx", "domains": ["ip-targets.p1"]}, settings)
        assert code == 0 and dispatched[0]["domains"] == ["ip-targets.p1"]
        assert dispatched[0]["ip_mode"] is True

    def test_a_root_no_longer_in_the_project_is_refused(self, pr, monkeypatch, capsys):
        code, _, dispatched = _run_main(pr, monkeypatch, {
            "tool_id": "Urlscan", "domains": ["alpha.test", "removed.test"]}, BATCH_SETTINGS)
        assert dispatched[0]["domains"] == ["alpha.test"]
        assert "removed.test: refused: no longer a project target" in capsys.readouterr().out

    def test_every_root_refused_exits_1_with_the_report(self, pr, monkeypatch, capsys):
        settings = dict(BATCH_SETTINGS, ROE_ENABLED=True, ROE_EXCLUDED_HOSTS=["alpha.test", "beta.test"])
        code, sweeps, dispatched = _run_main(pr, monkeypatch, {
            "tool_id": "Urlscan", "domains": ["alpha.test", "beta.test"]}, settings)
        out = capsys.readouterr().out
        assert code == 1 and dispatched == []
        assert "Run report: Urlscan" in out and "Roots scanned (0): none" in out
        assert "alpha.test: refused-roe" in out and "beta.test: refused-roe" in out

    def test_unreachable_settings_refuse_the_run(self, pr, monkeypatch):
        def _boom():
            raise ConnectionError("webapp down")

        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"tool_id": "Tlsx", "domains": ["alpha.test"]}, f)
        monkeypatch.setenv("PARTIAL_RECON_CONFIG", f.name)
        monkeypatch.setattr(pr, "get_settings", _boom)
        monkeypatch.setattr(pr, "_dispatch", lambda *a: pytest.fail("dispatched"))
        try:
            with pytest.raises(SystemExit) as ei:
                pr.main()
            assert ei.value.code == 1
        finally:
            os.unlink(f.name)


class TestOverridesAllowlist:
    def test_keys_outside_the_allowlist_are_dropped(self, pr, monkeypatch, capsys):
        code, _, dispatched = _run_main(pr, monkeypatch, {
            "tool_id": "Nuclei", "domains": ["alpha.test"],
            "settings_overrides": {"MITRE_ENABLED": False, "ROE_ENABLED": False,
                                   "ROE_EXCLUDED_HOSTS": []}}, BATCH_SETTINGS)
        assert dispatched[0]["settings_overrides"] == {"MITRE_ENABLED": False}
        out = capsys.readouterr().out
        assert "'ROE_ENABLED'" in out and "'ROE_EXCLUDED_HOSTS'" in out


class TestTheModuleSeesTheCheckedSettings:
    def test_settings_are_loaded_once_and_handed_over(self, pr, monkeypatch):
        loads = []

        def _load():
            loads.append(1)
            return dict(BATCH_SETTINGS, MARK="checked")

        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"tool_id": "Tlsx", "domains": ["alpha.test"]}, f)
        monkeypatch.setenv("PARTIAL_RECON_CONFIG", f.name)
        monkeypatch.setattr(pr, "get_settings", _load)
        monkeypatch.setattr(pr, "_apply_node_filters", lambda *_: None)
        seen = []
        monkeypatch.setattr(pr, "_dispatch", lambda t, cfg: seen.append(h.partial_settings(cfg)))
        try:
            pr.main()
        finally:
            os.unlink(f.name)
        assert len(loads) == 1
        assert seen[0]["MARK"] == "checked"


class TestReportAndExitCode:
    def test_a_tool_that_raises_fails_the_run_but_the_sweep_still_runs(self, pr, monkeypatch, capsys):
        def boom(cfg):
            raise RuntimeError("tool broke")

        code, sweeps, _ = _run_main(pr, monkeypatch, {
            "tool_id": "Tlsx", "domains": ["alpha.test"]}, BATCH_SETTINGS, dispatch=boom)
        out = capsys.readouterr().out
        assert code == 1 and len(sweeps) == 1
        assert "alpha.test: failed: RuntimeError" in out

    def test_a_tools_own_sys_exit_is_reported(self, pr, monkeypatch, capsys):
        def no_targets(cfg):
            sys.exit(1)

        code, sweeps, _ = _run_main(pr, monkeypatch, {
            "tool_id": "Tlsx", "domains": ["alpha.test"]}, BATCH_SETTINGS, dispatch=no_targets)
        assert code == 1 and len(sweeps) == 1
        assert "alpha.test: failed: SystemExit" in capsys.readouterr().out

    def test_a_loop_tools_statuses_decide_the_exit_code(self, pr, monkeypatch, capsys):
        statuses = {"alpha.test": "failed: HTTPError", "beta.test": STATUS_NO_RESULTS}
        code, sweeps, _ = _run_main(pr, monkeypatch, {
            "tool_id": "Urlscan", "domains": ["alpha.test", "beta.test"]}, BATCH_SETTINGS,
            dispatch=lambda cfg: statuses)
        out = capsys.readouterr().out
        assert code == 0 and len(sweeps) == 1
        assert "alpha.test: failed: HTTPError" in out and "beta.test: no_results" in out

    def test_every_loop_root_failing_exits_1(self, pr, monkeypatch):
        code, sweeps, _ = _run_main(pr, monkeypatch, {
            "tool_id": "Urlscan", "domains": ["alpha.test", "beta.test"]}, BATCH_SETTINGS,
            dispatch=lambda cfg: {"alpha.test": STATUS_RATE_LIMITED, "beta.test": "failed: X"})
        assert code == 1 and len(sweeps) == 1

    @pytest.mark.parametrize("tool_id", sorted(PARTIAL_TOOLS))
    def test_every_tool_is_handed_every_root(self, pr, monkeypatch, capsys, tool_id):
        # No tool is narrowed to one root any more: each receives the whole run.
        code, _, dispatched = _run_main(pr, monkeypatch, {
            "tool_id": tool_id, "domains": ["alpha.test", "beta.test"]}, BATCH_SETTINGS)
        assert code == 0
        assert dispatched[0]["domains"] == ["alpha.test", "beta.test"]
        assert "not scanned" not in capsys.readouterr().out

    def test_the_config_carries_the_scope_the_modules_read(self, pr, monkeypatch):
        _, _, dispatched = _run_main(pr, monkeypatch, {
            "tool_id": "Tlsx", "domains": ["alpha.test", "beta.test"]}, BATCH_SETTINGS)
        cfg = dispatched[0]
        assert cfg["domains"] == ["alpha.test", "beta.test"] and cfg["domain"] == "alpha.test"
        assert cfg["batch_mode"] is True and cfg["ip_mode"] is False
        assert [g["rootDomain"] for g in cfg["domain_groups"]] == ["alpha.test", "beta.test"]


# --- urlscan: a 429 is not "no results" -----------------------------------------------

class TestUrlscanRateLimitMarker:
    def _resp(self, status, results=None):
        r = mock.MagicMock()
        r.status_code = status
        r.json.return_value = {"results": results or []}
        r.text = ""
        return r

    def test_a_429_is_marked(self):
        from recon.main_recon_modules import urlscan_enrich as u
        with mock.patch.object(u.requests, "get", return_value=self._resp(429)):
            got = u._urlscan_search("alpha.test", "", 10)
        assert isinstance(got, u.RateLimitedResults) and got == []

    def test_an_empty_200_is_not(self):
        from recon.main_recon_modules import urlscan_enrich as u
        with mock.patch.object(u.requests, "get", return_value=self._resp(200)):
            got = u._urlscan_search("alpha.test", "", 10)
        assert not isinstance(got, u.RateLimitedResults)

    @pytest.mark.parametrize("status,limited", [(429, True), (200, False)])
    def test_the_enrichment_records_it(self, status, limited):
        from recon.main_recon_modules import urlscan_enrich as u
        with mock.patch.object(u.requests, "get", return_value=self._resp(status)):
            data = u.run_urlscan_discovery_only("alpha.test", {"URLSCAN_ENABLED": True})
        assert data["rate_limited"] is limited


# --- the webapp's mirrors of the container's sets --------------------------------------

class TestMirrorsStayInSync:
    """The webapp offers roots and sends overrides from its own copies of these
    sets; a drift would make the modal promise what the container refuses."""

    TS = PROJECT_ROOT / "webapp" / "src" / "lib" / "recon-types.ts"

    def _ts_list(self, name):
        import re
        if not self.TS.exists():
            pytest.skip("webapp/ is not mounted beside recon/")
        match = re.search(name + r"\b[^=]*=[^\[]*\[([^\]]*)\]", self.TS.read_text())
        assert match, f"{name} not found in recon-types.ts"
        return {x.strip().strip("'\"") for x in match.group(1).split(",") if x.strip()}

    def test_override_keys(self):
        from recon import partial_recon as module
        assert self._ts_list("PARTIAL_RECON_OVERRIDE_KEYS") == set(module.ALLOWED_SETTINGS_OVERRIDES)
