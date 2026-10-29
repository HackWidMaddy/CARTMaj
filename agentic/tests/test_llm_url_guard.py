"""Unit tests for the custom-LLM baseUrl SSRF guard (STRIDE I15 / I16).

Run with:
    python -m unittest tests.test_llm_url_guard -v
"""

import os
import sys
import unittest
from unittest import mock

_AGENTIC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _AGENTIC_DIR)

from orchestrator_helpers.llm_url_guard import (  # noqa: E402
    BaseUrlValidationError,
    validate_llm_base_url,
)


def _fake_resolver(mapping):
    """Return a patch target for socket.getaddrinfo driven by a host->ips map.

    Unknown hosts raise OSError (NXDOMAIN), matching real resolution failure.
    """
    import socket

    def _getaddrinfo(host, *args, **kwargs):
        if host in mapping:
            return [(socket.AF_INET, None, None, "", (ip, 0)) for ip in mapping[host]]
        raise OSError("Name or service not known")

    return _getaddrinfo


class AllowsLegitimateTargets(unittest.TestCase):
    """The self-hosted-model feature must keep working."""

    def test_empty_is_noop(self):
        validate_llm_base_url("")
        validate_llm_base_url(None)
        validate_llm_base_url("   ")

    def test_localhost_ollama(self):
        with mock.patch("socket.getaddrinfo", _fake_resolver({"localhost": ["127.0.0.1"]})):
            validate_llm_base_url("http://localhost:11434/v1")

    def test_loopback_literal(self):
        validate_llm_base_url("http://127.0.0.1:8080/v1")

    def test_private_lan_ranges(self):
        for url in (
            "http://192.168.1.50:11434/v1",
            "http://10.0.0.5:1234/v1",
            "http://172.16.4.4:11434/v1",
        ):
            validate_llm_base_url(url)

    def test_docker_service_name(self):
        with mock.patch("socket.getaddrinfo", _fake_resolver({"ollama": ["172.20.0.3"]})):
            validate_llm_base_url("http://ollama:11434/v1")

    def test_public_https_provider(self):
        with mock.patch("socket.getaddrinfo", _fake_resolver({"api.openai.com": ["1.2.3.4"]})):
            validate_llm_base_url("https://api.openai.com/v1")

    def test_unresolvable_host_allowed(self):
        # Cannot be an SSRF into metadata if it does not resolve.
        validate_llm_base_url("http://does-not-exist.invalid:11434/v1")

    def test_tls_off_allowed_for_private_host(self):
        validate_llm_base_url("https://192.168.1.50:8443/v1", ssl_verify=False)

    def test_tls_off_allowed_for_loopback(self):
        validate_llm_base_url("https://127.0.0.1:8443/v1", ssl_verify=False)


class BlocksSsrfTargets(unittest.TestCase):
    """Cloud metadata / link-local / bad schemes must be rejected."""

    def test_aws_imds_literal(self):
        with self.assertRaises(BaseUrlValidationError):
            validate_llm_base_url("http://169.254.169.254/latest/meta-data/")

    def test_aws_ecs_metadata(self):
        with self.assertRaises(BaseUrlValidationError):
            validate_llm_base_url("http://169.254.170.2/v2/credentials/")

    def test_alibaba_metadata(self):
        with self.assertRaises(BaseUrlValidationError):
            validate_llm_base_url("http://100.100.100.200/latest/meta-data/")

    def test_gcp_metadata_hostname(self):
        with self.assertRaises(BaseUrlValidationError):
            validate_llm_base_url("http://metadata.google.internal/computeMetadata/v1/")

    def test_dns_rebind_to_metadata(self):
        # Hostname that resolves to the metadata IP must be caught.
        with mock.patch(
            "socket.getaddrinfo", _fake_resolver({"evil.example.com": ["169.254.169.254"]})
        ):
            with self.assertRaises(BaseUrlValidationError):
                validate_llm_base_url("http://evil.example.com/v1")

    def test_ipv4_mapped_ipv6_metadata(self):
        # ::ffff:169.254.169.254 must be judged on the v4 value, not slip through.
        with mock.patch(
            "socket.getaddrinfo",
            _fake_resolver({"evil6.example.com": ["::ffff:169.254.169.254"]}),
        ):
            with self.assertRaises(BaseUrlValidationError):
                validate_llm_base_url("http://evil6.example.com/v1")

    def test_ipv6_imds_noncanonical(self):
        # Non-canonical spelling of fd00:ec2::254 must still match the blocklist.
        with mock.patch(
            "socket.getaddrinfo", _fake_resolver({"evil6b.example.com": ["fd00:ec2:0:0:0:0:0:254"]})
        ):
            with self.assertRaises(BaseUrlValidationError):
                validate_llm_base_url("http://evil6b.example.com/v1")

    def test_link_local_range(self):
        with self.assertRaises(BaseUrlValidationError):
            validate_llm_base_url("http://169.254.10.20:8000/v1")

    def test_encoded_ip_forms_blocked(self):
        # Integer/hex/octal encodings of 169.254.169.254. The guard resolves via
        # the same getaddrinfo httpx uses, which normalizes all of these to the
        # metadata IP — so the classic encoding bypass is caught, not slipped.
        for host in ("2852039166", "0xA9FEA9FE", "0251.0376.0251.0376"):
            with self.subTest(host=host):
                with self.assertRaises(BaseUrlValidationError):
                    validate_llm_base_url(f"http://{host}/latest/")

    def test_userinfo_at_metadata_blocked(self):
        # http://evil.com@169.254.169.254/ -> host IS the metadata IP (matches
        # what httpx connects to), so it must be blocked.
        with self.assertRaises(BaseUrlValidationError):
            validate_llm_base_url("http://evil.com@169.254.169.254/latest/")

    def test_userinfo_decoy_does_not_overblock(self):
        # http://169.254.169.254@realhost/ -> host is realhost (httpx connects
        # there), so the metadata string in userinfo must NOT cause a false block.
        with mock.patch(
            "socket.getaddrinfo", _fake_resolver({"realhost.example.com": ["1.2.3.4"]})
        ):
            validate_llm_base_url("http://169.254.169.254@realhost.example.com/v1")

    def test_non_http_scheme(self):
        for url in ("file:///etc/passwd", "gopher://127.0.0.1:6379/", "ftp://host/x"):
            with self.assertRaises(BaseUrlValidationError):
                validate_llm_base_url(url)

    def test_no_host(self):
        with self.assertRaises(BaseUrlValidationError):
            validate_llm_base_url("http:///nohost")


class BlocksTlsOffOnPublic(unittest.TestCase):
    """I16: disabling TLS verification toward a public host is rejected."""

    def test_tls_off_public_literal(self):
        with self.assertRaises(BaseUrlValidationError):
            validate_llm_base_url("https://8.8.8.8/v1", ssl_verify=False)

    def test_tls_off_public_hostname(self):
        with mock.patch(
            "socket.getaddrinfo", _fake_resolver({"evil-llm.example.com": ["8.8.4.4"]})
        ):
            with self.assertRaises(BaseUrlValidationError):
                validate_llm_base_url("https://evil-llm.example.com/v1", ssl_verify=False)

    def test_tls_on_public_is_fine(self):
        with mock.patch(
            "socket.getaddrinfo", _fake_resolver({"evil-llm.example.com": ["8.8.4.4"]})
        ):
            validate_llm_base_url("https://evil-llm.example.com/v1", ssl_verify=True)


if __name__ == "__main__":
    unittest.main()
