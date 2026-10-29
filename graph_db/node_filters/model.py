"""Parse and validate a node-filter rule document, failing closed.

A document is operator input that ends up deciding what the AI agent can see,
so nothing in it is trusted:

- **Denylist:** an invalid rule is skipped and reported; the valid ones still run.
- **Allowlist:** one invalid enabled rule deactivates its whole kind. An
  allowlist mutes everything a rule does NOT keep, so dropping a broken keep
  rule would mute exactly the findings it was written to keep.
- A document that does not parse at all means no filtering.

Values are normalised here (lowercased, CIDRs parsed, dates made aware) so the
evaluator compares like with like. A rule's `field` is resolved against the
catalog and never reaches Cypher; its values only ever travel as parameters.

The webapp validates the same document in `webapp/src/lib/nodeFilters/validate.ts`
before saving; the synthetic documents under `fixtures/` pin that the two agree.
"""
from __future__ import annotations

import ipaddress
import json
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

MODES = ("denylist", "allowlist")

#: Operators each field type accepts. Embedded into catalog.json by build.py,
#: so the webapp editor offers exactly these.
OPERATORS = {
    "number": ("lt", "lte", "gt", "gte", "eq", "between", "missing"),
    "ordinal": ("in", "not_in", "lt", "lte", "gt", "gte", "missing"),
    "enum": ("in", "not_in", "missing"),
    "text": ("eq", "not_eq", "contains", "not_contains", "starts_with", "ends_with",
             "glob", "not_glob", "missing"),
    "host": ("glob", "not_glob", "missing"),
    "url": ("glob", "not_glob", "missing"),
    "ip": ("in_cidr", "not_in_cidr", "missing"),
    "bool": ("is_true", "is_false", "missing"),
    "list": ("contains_any", "contains_all", "not_contains_any", "is_empty", "missing"),
    "date": ("before", "after", "older_than_days", "newer_than_days", "missing"),
}

#: Operators that take no value.
NO_VALUE_OPS = frozenset({"missing", "is_true", "is_false", "is_empty"})

LIMITS = {
    "rules_per_kind": 40,
    "conditions_per_rule": 8,
    "values_per_list": 200,
    "string_length": 256,
    "document_bytes": 64 * 1024,
    "glob_stars": 16,
    "max_days": 36500,
    "name_length": 80,
}

RULE_ID = re.compile(r"^[a-z0-9]{6,12}$")

#: Rule names reach muted_reason, reports, MCP clients and CSV, so the character
#: set is restricted at the source: letters, digits, space and `.,:()_/+-`.
_NAME_PUNCTUATION = frozenset(" .,:()_/+-")


def valid_rule_name(name) -> bool:
    if not isinstance(name, str) or not 1 <= len(name) <= LIMITS["name_length"]:
        return False
    if name.strip() != name or not name.strip():
        return False
    for ch in name:
        if ch in _NAME_PUNCTUATION:
            continue
        if unicodedata.category(ch)[0] not in ("L", "N"):
            return False
    return True


@dataclass
class Condition:
    field: str
    op: str
    #: Normalised: lowercased strings, a rank for an ordinal comparison, parsed
    #: networks for a CIDR, an aware datetime for a date bound.
    value: object = None


@dataclass
class Rule:
    id: str
    name: str
    enabled: bool
    conditions: list
    match_all: bool = False


@dataclass
class KindConfig:
    kind: str
    enabled: bool
    action: str = "mute"
    #: Valid ENABLED rules only; these are what the evaluator runs.
    rules: list = field(default_factory=list)
    #: Every rule id -> name, valid or not, enabled or not, for naming mutes.
    names: dict = field(default_factory=dict)
    errors: list = field(default_factory=list)
    active: bool = False


@dataclass
class NodeFilterConfig:
    mode: str
    kinds: dict = field(default_factory=dict)
    errors: list = field(default_factory=list)
    #: False when the document itself was unusable: nothing is filtered.
    ok: bool = True

    def active_kinds(self) -> list:
        return [k for k, v in self.kinds.items() if v.active]

    def rule_name(self, kind: str, rule_id: str) -> str | None:
        entry = self.kinds.get(kind)
        return entry.names.get(rule_id) if entry else None


class _Invalid(Exception):
    pass


def _string(value, what) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _Invalid(f"{what} must be a non-empty string")
    if len(value) > LIMITS["string_length"]:
        raise _Invalid(f"{what} is longer than {LIMITS['string_length']} characters")
    return value.strip()


def _string_list(value, what) -> list:
    if not isinstance(value, list) or not value:
        raise _Invalid(f"{what} must be a non-empty list")
    if len(value) > LIMITS["values_per_list"]:
        raise _Invalid(f"{what} has more than {LIMITS['values_per_list']} values")
    return [_string(v, what) for v in value]


def _number(value, what) -> float:
    # bool is an int in Python; `true` is not a number a rule meant.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _Invalid(f"{what} must be a number")
    if value != value or value in (float("inf"), float("-inf")):
        raise _Invalid(f"{what} must be a finite number")
    try:
        return float(value)
    except OverflowError:
        # A JSON integer has no size limit; 10**400 is not a float.
        raise _Invalid(f"{what} is too large") from None


def parse_datetime(value) -> datetime | None:
    """An aware datetime from an ISO string, a date, a datetime or a neo4j temporal."""
    if value is None or value == "":
        return None
    if hasattr(value, "to_native"):
        value = value.to_native()
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        # Neo4j renders nanoseconds and a `Z`; fromisoformat takes neither on 3.11.
        text = re.sub(r"(\.\d{6})\d+", r"\1", text).replace("Z", "+00:00")
        text = re.sub(r"\[[^\]]*\]$", "", text)
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


def _condition(raw, kind_def, catalog, where) -> Condition:
    if not isinstance(raw, dict):
        raise _Invalid(f"{where}: a condition must be an object")
    name = raw.get("field")
    fdef = kind_def["fields"].get(name) if isinstance(name, str) else None
    if fdef is None:
        raise _Invalid(f"{where}: unknown field {name!r}")
    ftype = fdef["type"]
    op = raw.get("op")
    if op not in OPERATORS[ftype]:
        raise _Invalid(f"{where}: operator {op!r} does not apply to {ftype} field {name!r}")
    value = raw.get("value")
    what = f"{where} ({name} {op})"

    if op in NO_VALUE_OPS:
        if value not in (None, "", []):
            raise _Invalid(f"{what} takes no value")
        return Condition(name, op, None)

    if ftype == "ordinal":
        scale = [s.lower() for s in catalog["ordinals"][fdef["scale"]]]
        if op in ("in", "not_in"):
            values = [v.lower() for v in _string_list(value, what)]
            bad = [v for v in values if v not in scale]
            if bad:
                raise _Invalid(f"{what}: {bad[0]!r} is not one of {', '.join(scale)}")
            return Condition(name, op, frozenset(values))
        v = _string(value, what).lower()
        if v not in scale:
            raise _Invalid(f"{what}: {v!r} is not one of {', '.join(scale)}")
        return Condition(name, op, scale.index(v))

    if ftype == "number":
        if op == "between":
            if not isinstance(value, list) or len(value) != 2:
                raise _Invalid(f"{what} needs two numbers")
            lo, hi = _number(value[0], what), _number(value[1], what)
            if lo > hi:
                raise _Invalid(f"{what}: the lower bound is above the upper one")
            return Condition(name, op, (lo, hi))
        return Condition(name, op, _number(value, what))

    if ftype == "enum":
        return Condition(name, op, frozenset(v.lower() for v in _string_list(value, what)))

    if ftype == "list":
        return Condition(name, op, frozenset(v.lower() for v in _string_list(value, what)))

    if ftype == "ip":
        nets = []
        for v in _string_list(value, what):
            try:
                nets.append(ipaddress.ip_network(v, strict=False))
            except ValueError:
                raise _Invalid(f"{what}: {v!r} is not an IP address or CIDR") from None
        return Condition(name, op, tuple(nets))

    if ftype == "date":
        if op in ("older_than_days", "newer_than_days"):
            days = _number(value, what)
            if not 0 <= days <= LIMITS["max_days"]:
                raise _Invalid(f"{what} must be between 0 and {LIMITS['max_days']} days")
            return Condition(name, op, days)
        parsed = parse_datetime(_string(value, what))
        if parsed is None:
            raise _Invalid(f"{what}: {value!r} is not an ISO date")
        return Condition(name, op, parsed)

    # text, host, url
    text = _string(value, what)
    if op in ("glob", "not_glob") and text.count("*") > LIMITS["glob_stars"]:
        raise _Invalid(f"{what}: more than {LIMITS['glob_stars']} wildcards")
    return Condition(name, op, text.lower())


def _rule(raw, kind_def, catalog, mode, where, seen_ids) -> Rule:
    if not isinstance(raw, dict):
        raise _Invalid(f"{where}: a rule must be an object")
    rule_id = raw.get("id")
    if not isinstance(rule_id, str) or not RULE_ID.match(rule_id):
        raise _Invalid(f"{where}: rule id must be 6-12 lowercase letters or digits")
    if rule_id in seen_ids:
        raise _Invalid(f"{where}: duplicate rule id {rule_id!r}")
    seen_ids.add(rule_id)
    name = raw.get("name")
    if not valid_rule_name(name):
        raise _Invalid(f"{where}: rule names are 1-80 letters, digits, spaces or .,:()_/+-")
    enabled = raw.get("enabled", True)
    if not isinstance(enabled, bool):
        raise _Invalid(f"{where}: enabled must be true or false")
    match_all = raw.get("match_all", False)
    if not isinstance(match_all, bool):
        raise _Invalid(f"{where}: match_all must be true or false")
    conditions = raw.get("all", [])
    if not isinstance(conditions, list):
        raise _Invalid(f"{where}: `all` must be a list")
    if len(conditions) > LIMITS["conditions_per_rule"]:
        raise _Invalid(f"{where}: more than {LIMITS['conditions_per_rule']} conditions")
    if match_all and mode == "allowlist":
        raise _Invalid(f"{where}: `match all` is refused in allowlist mode")
    if not conditions and not match_all:
        raise _Invalid(f"{where}: a rule needs at least one condition")
    if match_all and conditions:
        raise _Invalid(f"{where}: a `match all` rule takes no conditions")
    parsed = [_condition(c, kind_def, catalog, f"{where} condition {i + 1}")
              for i, c in enumerate(conditions)]
    return Rule(rule_id, name, enabled, parsed, match_all)


def _load(doc):
    if isinstance(doc, (bytes, bytearray)):
        doc = doc.decode("utf-8")
    if isinstance(doc, str):
        if len(doc.encode("utf-8")) > LIMITS["document_bytes"]:
            raise _Invalid("the rule document is larger than 64 KB")
        doc = json.loads(doc)
    elif doc is not None:
        if len(json.dumps(doc, default=str).encode("utf-8")) > LIMITS["document_bytes"]:
            raise _Invalid("the rule document is larger than 64 KB")
    return doc


def parse(doc, mode: str, catalog, phases=None) -> NodeFilterConfig:
    """Validate `doc` (the `rules` JSON) for `mode` against a built catalog dict.

    `catalog` is the built catalog (a `Catalog` or the dict from catalog.json).
    `phases` limits which kinds may be filtered; by default the catalog's
    enabled phases. Never raises: every problem is in `errors`.
    """
    cat = catalog.data if hasattr(catalog, "data") else catalog
    phases = set(phases or cat.get("enabled_phases") or [1])
    if mode not in MODES:
        return NodeFilterConfig(mode="denylist", ok=False,
                                errors=[f"unknown mode {mode!r}; nothing is filtered"])
    try:
        raw = _load(doc)
    except (_Invalid, ValueError, TypeError, RecursionError) as e:
        # RecursionError: nesting within the size cap can still be too deep to decode.
        return NodeFilterConfig(mode=mode, ok=False, errors=[f"unreadable rules: {e}"])
    if raw is None:
        return NodeFilterConfig(mode=mode)
    if not isinstance(raw, dict) or raw.get("version", 1) != 1:
        return NodeFilterConfig(mode=mode, ok=False,
                                errors=["the rules must be a version 1 document"])
    kinds_raw = raw.get("kinds", {})
    if not isinstance(kinds_raw, dict):
        return NodeFilterConfig(mode=mode, ok=False, errors=["`kinds` must be an object"])

    config = NodeFilterConfig(mode=mode)
    for kind, entry in kinds_raw.items():
        kind_def = cat["kinds"].get(kind) if isinstance(kind, str) else None
        if kind_def is None:
            config.errors.append(f"unknown kind {kind!r}: ignored")
            continue
        if kind_def.get("phase") not in phases:
            config.errors.append(f"kind {kind!r} cannot be filtered yet: ignored")
            continue
        if not isinstance(entry, dict):
            config.errors.append(f"{kind}: must be an object: ignored")
            continue
        enabled = entry.get("enabled", False)
        kc = KindConfig(kind=kind, enabled=enabled is True)
        if entry.get("action", "mute") != "mute":
            kc.errors.append(f"{kind}: only the mute action exists in this phase")
            config.kinds[kind] = kc
            continue
        rules_raw = entry.get("rules", [])
        if not isinstance(rules_raw, list):
            kc.errors.append(f"{kind}: `rules` must be a list")
            config.kinds[kind] = kc
            continue
        if len(rules_raw) > LIMITS["rules_per_kind"]:
            kc.errors.append(f"{kind}: more than {LIMITS['rules_per_kind']} rules")
            config.kinds[kind] = kc
            continue

        seen_ids: set = set()
        invalid_enabled = False
        for i, raw_rule in enumerate(rules_raw):
            where = f"{kind} rule {i + 1}"
            if isinstance(raw_rule, dict):
                rid, rname = raw_rule.get("id"), raw_rule.get("name")
                if isinstance(rid, str) and isinstance(rname, str):
                    kc.names.setdefault(rid, rname)
            try:
                rule = _rule(raw_rule, kind_def, cat, mode, where, seen_ids)
            except _Invalid as e:
                kc.errors.append(str(e))
                enabled_rule = not isinstance(raw_rule, dict) or raw_rule.get("enabled", True) is not False
                invalid_enabled = invalid_enabled or enabled_rule
                continue
            if rule.enabled:
                kc.rules.append(rule)

        if mode == "allowlist" and invalid_enabled:
            kc.errors.append(f"{kind}: an invalid keep rule deactivates the whole kind in allowlist mode")
            kc.rules = []
        kc.active = kc.enabled and bool(kc.rules)
        config.kinds[kind] = kc
    return config
