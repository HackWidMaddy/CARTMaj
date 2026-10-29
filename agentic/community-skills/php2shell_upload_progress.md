# php2shell Upload-Progress Exposure Check (CVE-2026-109618 / CVE-2026-109619)

Detection and triage workflow for the php2shell class of PHP core vulnerabilities: the heap use-after-free in the `ext/session` RFC1867 upload-progress handler (`session.upload_progress`) that can reach `zend_call_function` / `system()` on an unpatched build. This skill determines, black-box, whether a target PHP stack is exposed (version in an affected range, the upload-progress feature reachable), corroborates exposure with a single non-destructive probe, and reports the exposure with the concrete mitigation and a fix-verification re-probe. It does NOT run the memory-corruption exploit chain; its product is a confident vulnerable / not-vulnerable / mitigated verdict and a remediation the operator can act on. It also records the defensive layers it can observe in front of the host (CDN / WAF / reverse proxy) and rates residual risk with declared uncertainty, never conflating an edge filter with a patched origin.

## When to Classify Here

Pick this skill when the task is to decide whether a host is exposed to php2shell / the PHP session upload-progress use-after-free, or to confirm a mitigation for it, including:

- "Is this server affected by CVE-2026-109618 / CVE-2026-109619 (php2shell)?"
- "Check whether this PHP box is vulnerable to the session upload-progress RCE."
- "We applied `session.upload_progress.enabled = Off`, confirm the host is no longer exposed."
- "Triage our PHP fleet for the php2shell advisory and tell me what to patch."
- "Did the ModSecurity / WAF rule for `PHP_SESSION_UPLOAD_PROGRESS` take effect?"

Keywords: php2shell, CVE-2026-109618, CVE-2026-109619, session.upload_progress, PHP_SESSION_UPLOAD_PROGRESS, RFC1867, upload progress, use-after-free, UAF, ext/session, zend_call_function, php-fpm, mod_php, FrankenPHP, exposure check, affected version, mitigation verification.

### Disjoint from neighbouring skills

- vs. `cve_exploit` (built-in): `cve_exploit` is the generic "exploit this named CVE" path. This skill is a focused, non-weaponising exposure + mitigation playbook for one specific advisory. If the user explicitly wants a full exploitation / RCE proof (not just a verdict), that is `cve_exploit` territory and requires a build-calibrated PoC run manually in an authorized lab; this skill stops at confirmation and remediation.
- vs. `rce` (built-in): `rce` stabilises and operates an already-obtained foothold. This skill does not obtain a foothold; it decides exposure. Do not hand off to `rce` from here unless a foothold was obtained by other authorized means.
- vs. `insecure_file_uploads` (community, @HackWidMaddy): that skill abuses an application's file-upload feature (web shells, SVG XSS, zip slip). This skill is about a PHP-core memory-safety defect reachable through any multipart POST; the entry point is the PHP runtime, not an upload form. If the finding is an app-level upload weakness, classify there.
- vs. `insecure_deserialization` (community): PHP session data is involved, but the defect here is a dangling bucket pointer in the upload-progress counters, not a crafted serialized gadget. If the target is a `unserialize()` sink or a PHP object-injection gadget chain, classify there.

## Tools

- `execute_httpx` to fingerprint the web server and PHP version from response headers (`Server`, `X-Powered-By`) across the target's live endpoints.
- `query_graph` to inventory the target's HTTP Endpoints and any Technology / banner nodes already recorded, so the check runs against real hosts instead of guesses.
- `cve_intel` and `web_search` to resolve the authoritative fixed versions for each affected branch from the advisory (do not hardcode belief; confirm the current fixed builds).
- `execute_curl` for the single non-destructive multipart probe and for the mitigation re-probe (expecting a 403 / blocked response once a rule is in place).
- `execute_code` for parsing a fingerprinted version string against the affected ranges and for formatting the triage verdict.
- `execute_curl` / `execute_code` to read the response headers that reveal a CDN, WAF or reverse proxy in front of the host (`Server: cloudflare`, `CF-Ray`, `X-Akamai-*`, `Via`, `X-Cache`), so the verdict separates the edge from the origin. No extra fingerprinting binary is needed.
- `kali_shell` for `jq` when shaping JSON output.

## Workflow

Three phases, all non-destructive. Phase 1 establishes the version and the affected-range verdict. Phase 2 corroborates that the vulnerable feature is reachable and (when a mitigation has been applied) verifies it. Phase 3 reports exposure and remediation. This skill never performs the heap-grooming / fake-object / `zend_call_function` chain; forcing the handler to crash is a disruptive action gated behind an explicit, single-shot, lab-only note in Phase 2.

### Phase 1: Fingerprint and Affected-Range Verdict (Informational)

1. **Inventory live HTTP endpoints with `query_graph`**: ask "list Endpoints and any Technology/banner nodes for the target host, with their Server and X-Powered-By values". Pick a reachable PHP endpoint (a `.php` page, or any route whose response advertises PHP).

2. **Fingerprint the stack**: capture `Server` (Apache / nginx / FrankenPHP) and `X-Powered-By: PHP/<version>`. Read the headers directly with `execute_curl`:
   ```
   execute_curl> -sI https://target.tld/index.php
   ```
   and/or take structured fingerprinting with `execute_httpx`:
   ```
   execute_httpx> -u https://target.tld/ -sc -title -server -td -fr -silent -j
   ```
   If `X-Powered-By` is suppressed, read the version from an error page, a `phpinfo` route if one is exposed, or infer a PHP session stack from a `Set-Cookie: PHPSESSID` response (treat a hidden version as "unknown, assume exposed until proven patched").

   From the same headers, record whether a CDN, WAF or reverse proxy sits in front (`Server: cloudflare`, `CF-Ray`, `X-Akamai-*`, `Via`, `X-Cache`). This decides two things later: whether the version banner you read belongs to the origin or was rewritten or stripped by the edge, and whether a blocked probe reflects the edge or the origin. If the edge masks the version, mark the verdict inconclusive and name the edge.

3. **Resolve the authoritative fixed versions with `cve_intel` / `web_search`**: confirm, from the advisory, the first fixed release of each supported branch and which branches are end-of-life (no official fix). Do not rely on memory for the exact fixed build numbers; they change as point releases ship.

4. **Decide the affected-range verdict with `execute_code`**: compare the fingerprinted `PHP/<major.minor.patch>` against the confirmed fixed builds per branch. A build earlier than its branch's fixed release, or on an end-of-life branch with the feature reachable, is **affected**. A build at or above the fixed release is **not affected by this defect**. A hidden or ambiguous version is **inconclusive (assume exposed)** pending Phase 2.

Record the verdict (affected / not affected / inconclusive) and the evidence (the exact version string and its source). Then, for corroboration and mitigation verification only, request transition to exploitation phase.

### Phase 2: Exposure Corroboration and Mitigation Verification

The goal here is confirmation, not compromise.

1. **Confirm the upload-progress feature path is reachable (non-destructive).** `session.upload_progress.enabled` is on by default in affected PHP builds. Send one ordinary multipart POST that carries the progress field and a small file, with a client-chosen session cookie, and observe that it is accepted and handled normally (a 2xx/3xx/normal app response, a `Set-Cookie: PHPSESSID`), which shows the multipart + session path the defect lives behind is active and not filtered:
   ```
   execute_curl> -s -i -c - -b "PHPSESSID=exposurecheck0001" \
     -F "PHP_SESSION_UPLOAD_PROGRESS=probe" \
     -F "f=@/etc/hostname;filename=a.txt;type=application/octet-stream" \
     https://target.tld/index.php
   ```
   A normal response with the field accepted corroborates exposure on an affected version. A `403`/block means something filters the field: attribute it to the edge or the origin using the Phase 1 header fingerprint (an edge block page or `CF-Ray` on the 403 points at the edge). An edge filter is not proof the origin is patched (see Residual-Risk Rating); then go to step 3.

2. **(Optional, single-shot, lab-only) Behavioural tell.** On a build whose `memory_limit` is below a large multipart field, a vulnerable-configuration server responds abnormally while processing the progress handler: an HTTP 500, a PHP `Allowed memory size ... exhausted` message in the response body when `display_errors` is on, or an aborted / truncated response. All of these are observed from the HTTP response, black-box, not from server logs. This momentarily disrupts the handling worker, so treat it as a disruptive action: run it at most once, only on a target you are explicitly authorized to disrupt, and never in a loop (repeated runs thrash workers and tend toward denial of service, which is out of scope). Prefer the version verdict and step 1 as the basis for the finding; use this tell only when the version is hidden and a non-disruptive verdict cannot be reached, and record that you ran it.

3. **Verify a mitigation when one is claimed or applied.** After the operator sets `session.upload_progress.enabled = Off`, or installs the `PHP_SESSION_UPLOAD_PROGRESS` ModSecurity rule, or the multipart block at the edge, re-run the step 1 probe and confirm the exposure signal is gone: the field is rejected (`403`), or the feature is no longer honoured. A mitigation that still accepts the field and feature is not effective; report it as such.

### Phase 3: Reporting and Remediation

Summarise the verdict and hand the operator an actionable fix.

1. **State the verdict** (affected / not affected / mitigated / edge-mitigated (origin unverified) / inconclusive) with the version evidence, the corroboration result, and the residual-risk rating below.
2. **Give the remediation**, in priority order:
   - Upgrade PHP to the fixed release for the branch (confirmed in Phase 1 step 3). This is the real fix.
   - Immediate stopgap: `session.upload_progress.enabled = Off` in `php.ini`, or `php_admin_flag[session.upload_progress.enabled] = off` in the FPM pool, then reload the service.
   - Edge / WAF: block the `PHP_SESSION_UPLOAD_PROGRESS` field (ModSecurity `@streq` on `ARGS_NAMES`), or block `multipart/form-data` on routes that do not accept uploads.
   - End-of-life branches (no official patch): isolate the host, apply the config stopgap, or move to a supported branch.
   - Behind a CDN or WAF: an edge rule is a compensating control, not a fix. Restrict the origin to accept traffic only from the edge (CDN-to-origin IP allowlist, authenticated origin pulls or mTLS) so the edge filter cannot be sidestepped, and still patch the origin.
3. **Verify-after-fix**: include the Phase 2 step 3 re-probe result so the operator has proof the mitigation took effect.

## Residual-Risk Rating (layer-aware)

A vulnerable version starts the assessment; it does not end it. Rate residual risk from what you observed, and name what you could not observe. This rating drives remediation priority. It is not a measure of how easy the host is to exploit, and this skill never tests whether any layer can be defeated.

| Rating | When to assign it |
|---|---|
| **Resolved** | Origin runs a fixed build, or the operator supplies evidence that upload progress is off at the origin (still recommend the upgrade). |
| **Reduced (compensating control)** | Affected version, but a filter in front blocks the progress field and the operator confirms the origin only accepts traffic from that edge. |
| **Edge-mitigated (origin unverified)** | Affected or unknown version, an edge filter blocks the probe, and nothing shows the origin is unreachable except through that edge. |
| **Exposed** | Affected version, the progress field is accepted, no filter observed. Patch first. |
| **Unknown** | Version masked or unreadable and no filter observed. Treat as exposed until proven otherwise. |

**Observable black-box:** the version banner, CDN / WAF / reverse-proxy presence from headers, and whether the probe is accepted or filtered.

**Not observable black-box:** PHP hardening settings (such as `disable_functions`, `memory_limit`), OS sandboxing, and how the origin's network access is restricted. These are defense in depth, not a fix. Count them only when the operator supplies configuration evidence; never assume them present, and never let an unobserved control lower the rating.

**Edge is not origin.** A filter at a CDN or reverse proxy protects only the traffic that passes through it. Keep `edge-mitigated (origin unverified)` distinct from `mitigated`, which is reserved for a patched origin or the feature being off at the origin. If the engagement scope includes the origin address, run the same Phase 2 step 1 probe against it and rate on that result; otherwise record the origin as unverified.

## Reporting Guidelines

Each finding must include:

- **Class**: PHP core session upload-progress use-after-free (php2shell), CVE-2026-109618 / CVE-2026-109619.
- **Verdict**: affected / not affected / mitigated / edge-mitigated (origin unverified) / inconclusive.
- **Residual risk**: the rating (resolved / reduced / edge-mitigated / exposed / unknown) and the observations that set it.
- **Layers**: the CDN / WAF / reverse-proxy fingerprint seen, and the layers that could not be observed, stated as unknowns.
- **Evidence**: the fingerprinted PHP version and its source, plus the corroboration probe response (headers excerpt).
- **Affected-range basis**: the fixed build used for the comparison and where it was confirmed (advisory link via `cve_intel` / `web_search`).
- **Impact**: unauthenticated remote code execution on an unpatched, exposed build (state it as potential; this skill does not demonstrate execution).
- **CVSS**: per the advisory (critical for the RCE path).
- **Remediation**: the priority-ordered list above, with the exact directive and the service reload.
- **Fix verification**: the re-probe result after any applied mitigation.
- **References**: the official PHP advisory and release notes for the fixed builds (confirm live; do not cite stale version numbers).

## Important Notes

- **This is a detection and triage skill, by design.** It confirms exposure and remediation; it does not perform the heap-grooming, address-leak, fake-object, or `zend_call_function` steps. A full exploitation proof needs a build-calibrated PoC run by hand in an authorized lab and is deliberately out of scope here.
- **Black-box only.** Decide exposure from observable version and behaviour; never assume target source, offsets, or memory layout. A hidden version is "inconclusive, assume exposed", not an invitation to guess internals.
- **The behavioural tell is disruptive; use it sparingly.** A forced memory-exhaustion check momentarily breaks the handling worker. Single-shot, authorized targets only, never looped. Denial of service is out of scope.
- **Do not block on the `PHPSESSID` cookie alone.** Filtering valid session cookies breaks legitimate users; the correct edge mitigation targets the `PHP_SESSION_UPLOAD_PROGRESS` field or the multipart content type on non-upload routes.
- **An edge filter is not a patched origin.** A CDN or WAF rule that blocks the field protects only the traffic through it. Never report a host as `mitigated` on the strength of an edge 403 alone.
- **Declare what you could not observe.** Hardening and sandboxing settings are invisible black-box; list them as unknowns and never claim certainty either way.
- **Confirm fixed versions at run time.** Point releases ship continuously; resolve the current fixed build via `cve_intel` / `web_search` rather than trusting a number baked into this file.
- **No em dashes** anywhere in artifacts that flow into the report. Use hyphens.
