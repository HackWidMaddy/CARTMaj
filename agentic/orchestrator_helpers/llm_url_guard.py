"""SSRF guard for user-supplied custom LLM ``baseUrl`` values.

A custom OpenAI-compatible / Anthropic provider lets the operator point the
agent at a self-hosted model (Ollama, LM Studio, an internal gateway). Those
live on ``localhost`` / LAN, so the guard must *preserve* private and loopback
targets. What it rejects is the narrow set that is never a legitimate model
endpoint and that turns the key-holding agent container into an SSRF probe:

  * non-``http(s)`` schemes (``file://``, ``gopher://`` ...);
  * cloud metadata / link-local addresses (AWS/GCP/Azure ``169.254.169.254``,
    AWS ECS ``169.254.170.2``, Alibaba ``100.100.100.200``, AWS IPv6 IMDS
    ``fd00:ec2::254``, and the ``metadata.google.internal`` host);
  * disabling TLS verification (``sslVerify=false``) for a *public* host: the
    self-signed use case is internal-only, and turning verification off on a
    public connection that carries ``Authorization: Bearer <key>`` + the prompt
    is the I16 MITM exposure.

This addresses STRIDE threats I15 (baseUrl SSRF) and I16 (TLS-off MITM) without
breaking the self-hosted-model feature. See
``internal/security/README.TM.STRIDE.md``.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


class BaseUrlValidationError(ValueError):
    """Raised when a custom LLM ``baseUrl`` is rejected by the SSRF guard."""


# Addresses that are never a legitimate LLM endpoint. Link-local (169.254/16,
# fe80::/10) is caught generically below; these are the extra metadata hosts
# that fall outside the link-local range.
_BLOCKED_IPS = frozenset({
    "169.254.169.254",  # AWS / GCP / Azure IMDS (also link-local)
    "169.254.170.2",    # AWS ECS task metadata (also link-local)
    "100.100.100.200",  # Alibaba Cloud metadata (CGNAT 100.64/10, not private)
    "fd00:ec2::254",    # AWS IPv6 IMDS (unique-local, not link-local)
})

_BLOCKED_HOSTNAMES = frozenset({
    "metadata.google.internal",
    "metadata.goog",
})

# Normalized objects so non-canonical IPv6 spellings (e.g. fd00:ec2:0::254)
# still match the blocklist rather than slipping through a string compare.
_BLOCKED_IP_OBJS = frozenset(ipaddress.ip_address(x) for x in _BLOCKED_IPS)


def _resolve_ips(host: str) -> list[str]:
    """Resolve ``host`` to all A/AAAA addresses. Empty list on failure.

    A literal IP returns itself. An unresolvable host returns ``[]``: it cannot
    be an SSRF into metadata, so the caller treats that as allowed.
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return []
    out: list[str] = []
    for info in infos:
        addr = info[4][0]
        out.append(addr.split("%")[0])  # strip IPv6 scope id
    return out


def _is_blocked_ip(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    # IPv4-mapped IPv6 (::ffff:169.254.169.254) must be judged on the v4 value.
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if ip in _BLOCKED_IP_OBJS:
        return True
    # Link-local covers 169.254.0.0/16 (IMDS) and fe80::/10.
    return ip.is_link_local


def _is_public_ip(ip_str: str) -> bool:
    try:
        return ipaddress.ip_address(ip_str).is_global
    except ValueError:
        return False


def validate_llm_base_url(base_url: str | None, *, ssl_verify: bool = True) -> None:
    """Validate a custom LLM ``baseUrl``; raise ``BaseUrlValidationError`` if unsafe.

    No-ops on an empty value (the provider falls back to its built-in default).
    Localhost / private / Docker-service / unresolvable hosts are allowed so the
    self-hosted-model feature keeps working.
    """
    if not base_url or not base_url.strip():
        return

    parsed = urlparse(base_url.strip())
    scheme = parsed.scheme.lower()
    if scheme not in ("http", "https"):
        raise BaseUrlValidationError(
            f"Custom LLM baseUrl must use http or https (got '{scheme or 'no scheme'}')."
        )

    host = parsed.hostname
    if not host:
        raise BaseUrlValidationError("Custom LLM baseUrl has no host.")

    if host.lower().rstrip(".") in _BLOCKED_HOSTNAMES:
        raise BaseUrlValidationError(
            "Custom LLM baseUrl points at a cloud metadata host, which is not allowed."
        )

    resolved = _resolve_ips(host)
    for ip in resolved:
        if _is_blocked_ip(ip):
            raise BaseUrlValidationError(
                f"Custom LLM baseUrl resolves to a blocked address ({ip}); "
                "cloud metadata and link-local endpoints are not allowed."
            )

    if not ssl_verify and any(_is_public_ip(ip) for ip in resolved):
        raise BaseUrlValidationError(
            "TLS verification cannot be disabled (sslVerify=false) for a public "
            "LLM endpoint; it is only permitted for private/internal hosts."
        )
