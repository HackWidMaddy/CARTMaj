"""The recon image patches an upstream arjun typo; this guards that it stuck.

arjun 2.2.7 __main__.py, on an unhealthy URL (HTTP 400/413/418/429/503), printed
`request.status_code` where `request` is the request DICT, not the response,
raising AttributeError instead of the intended warning. The recon Dockerfile
rewrites it to `response_1.status_code` (the real response, in scope on that
line). If a future arjun bump reintroduces the bug, or the patch step is
dropped, this fails so it is noticed rather than fouling every scan log.

Skips cleanly when arjun is not installed (e.g. a section image without it).
"""
import os
import pytest


def _arjun_main_source():
    try:
        import arjun
    except Exception:
        pytest.skip("arjun not installed in this image")
    path = os.path.join(os.path.dirname(arjun.__file__), "__main__.py")
    if not os.path.exists(path):
        pytest.skip("arjun __main__.py not found")
    return path, open(path, encoding="utf-8", errors="replace").read()


def test_arjun_does_not_read_status_code_off_the_request_dict():
    _path, src = _arjun_main_source()
    assert "% (bad, request.status_code))" not in src, (
        "the arjun status_code typo is back (request dict has no .status_code); "
        "the recon Dockerfile patch step must run after pip install")


def test_the_patched_line_uses_the_response():
    _path, src = _arjun_main_source()
    # The warning line still exists, now reading the response, not the request.
    if "this may cause problems" in src:
        assert "% (bad, response_1.status_code))" in src
