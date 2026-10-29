"""Vuln-scan helpers that read one root, over a Domain batch run.

  - the DNS security checks (SPF, DMARC, DNSSEC, zone transfer) ran on
    recon_data["domain"] only; they now run once per root in "domains";
  - the takeover scan's target list included only the first root's apex.

Fixture roots are alpha.test / beta.test / gamma.test only.
"""
import sys
from pathlib import Path
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from recon.helpers import security_checks  # noqa: E402
from recon.main_recon_modules.subdomain_takeover import _collect_subdomains  # noqa: E402

ROOTS = ["alpha.test", "beta.test", "gamma.test"]
DNS_ONLY = {name: name in ("spf_missing", "dmarc_missing", "dnssec_missing", "zone_transfer")
            for name in ("spf_missing", "dmarc_missing", "dnssec_missing", "zone_transfer",
                         "direct_ip_http", "missing_coop", "admin_port_exposed", "no_rate_limiting")}


def _recon(**extra):
    return {"dns": {"domain": {}, "subdomains": {}}, **extra}


def _dns_checked(recon_data):
    seen = []

    def fake(domain, enabled_checks, timeout=10):
        seen.append(domain)
        return [{"type": "spf_missing", "domain": domain}]

    with patch.object(security_checks, "run_dns_checks", side_effect=fake):
        result = security_checks.run_security_checks(recon_data, DNS_ONLY)
    return seen, result


class TestDnsChecksPerRoot:
    def test_every_root_is_checked_once(self):
        seen, result = _dns_checked(_recon(domain="alpha.test", domains=ROOTS + ["beta.test"]))
        assert seen == ROOTS
        findings = result["security_checks"]["findings"]
        assert sorted(f["domain"] for f in findings) == sorted(ROOTS)

    def test_the_single_domain_form_is_unchanged(self):
        seen, _ = _dns_checked(_recon(domain="alpha.test"))
        assert seen == ["alpha.test"]

    def test_no_domain_runs_no_dns_check(self):
        seen, _ = _dns_checked(_recon(domain="", domains=[]))
        assert seen == []

    def test_blank_roots_are_skipped(self):
        assert security_checks._dns_check_domains({"domains": ["", " ", "beta.test", None]}) == ["beta.test"]


class TestTakeoverTargets:
    def test_every_root_apex_is_a_target(self):
        names = _collect_subdomains({"domain": "alpha.test", "domains": ROOTS,
                                     "dns": {"subdomains": {"api.beta.test": {}}}})
        assert set(names) == set(ROOTS) | {"api.beta.test"}

    def test_the_single_domain_form_is_unchanged(self):
        names = _collect_subdomains({"domain": "Alpha.test", "dns": {"subdomains": {"www.alpha.test": {}}}})
        assert set(names) == {"alpha.test", "www.alpha.test"}

    def test_the_metadata_target_is_still_the_fallback(self):
        names = _collect_subdomains({"metadata": {"target": "gamma.test"}, "dns": {}})
        assert names == ["gamma.test"]
