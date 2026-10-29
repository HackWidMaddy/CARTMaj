"""W7 — structured cross-tree memory (the digest a new LATS tree inherits).

Instead of `ruled out: <bare tool_names>`, a finished tree now contributes its
SEMANTIC knowledge: confirmed LEADS (class @ target, with the actionable
reflection) to build on, and confirmed-DEAD `class @ target` pairs never to
re-attempt. These MERGE and dedupe across ALL trees, so tree N inherits one clean
union of every prior tree's knowledge (not N repetitive per-tree blobs).

Critical correctness rule pinned here: a node that never reached the app (a
diagnostic/transport failure) or that the LLM left unclassified is NEVER recorded
as ruled-out — otherwise a broken-tooling probe would wrongly kill a live vector.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import project_settings  # noqa: E402
from orchestrator_helpers import lats  # noqa: E402
from state import ExploitTree, ExploitTreeNode, AgentState  # noqa: E402


def _node(cid, rc, args, status="evaluated", ec="application_4xx", reflection="",
          succ=False, tool="execute_curl"):
    return ExploitTreeNode(id=cid, parent_id="root", depth=1, status=status,
                           tool_name=tool, tool_args={"args": args}, response_class=rc,
                           error_class=ec, reflection=reflection, exploit_succeeded=succ)


def _tree(nodes, objective="reach flag", best_terminal_id=None):
    root = ExploitTreeNode(id="root", status="evaluated", depth=0)
    t = ExploitTree(root_id="root", nodes={"root": root}, objective=objective,
                    best_terminal_id=best_terminal_id)
    for n in nodes:
        t.nodes[n.id] = n
        root.children.append(n.id)
    return t


class TestKnowledgeExtraction(unittest.TestCase):
    def test_leads_carry_class_target_and_reflection(self):
        t = _tree([_node("a", "error_leak", "http://x/api?principal=1 UNION",
                         reflection="weaponize the leak")])
        leads, dead = lats._tree_leads_and_dead(t)
        self.assertEqual(len(leads), 1)
        self.assertIn("error_leak", leads[0])
        self.assertIn("principal", leads[0])
        self.assertIn("weaponize the leak", leads[0])
        self.assertEqual(dead, [])

    def test_dead_classes_recorded(self):
        t = _tree([_node("a", "dead_endpoint", "http://x/admin", status="pruned"),
                   _node("b", "filter_whitelist", "http://x/login")])
        leads, dead = lats._tree_leads_and_dead(t)
        self.assertEqual(leads, [])
        self.assertTrue(any("dead_endpoint" in d for d in dead))
        self.assertTrue(any("filter_whitelist" in d for d in dead))

    def test_diagnostic_node_NEVER_ruled_out(self):
        # transport/tool failure never reached the app -> proves nothing
        t = _tree([_node("a", "", "http://x/p=1", ec="transport_error", status="pruned"),
                   _node("b", "dead_endpoint", "http://x/p=2", ec="application_5xx_fast",
                         status="pruned")])
        leads, dead = lats._tree_leads_and_dead(t)
        self.assertEqual(dead, [])          # both excluded (unclassified + diagnostic ec)
        self.assertEqual(leads, [])

    def test_precondition_classes_not_carried(self):
        # auth_required / waf_block are transient, not a verdict on the vector
        t = _tree([_node("a", "auth_required", "http://x/admin"),
                   _node("b", "waf_block", "http://x/q=1"),
                   _node("c", "wrong_method", "http://x/api")])
        leads, dead = lats._tree_leads_and_dead(t)
        self.assertEqual(leads, [])
        self.assertEqual(dead, [])

    def test_proposed_nodes_excluded(self):
        t = _tree([_node("a", "dead_endpoint", "http://x/admin", status="proposed")])
        self.assertEqual(lats._tree_leads_and_dead(t), ([], []))

    def test_within_tree_dedup_by_class_and_target(self):
        # same class@target from two probes collapses to one line
        t = _tree([_node("a", "dead_endpoint", "http://x/admin?a=1", status="pruned"),
                   _node("b", "dead_endpoint", "http://x/admin?a=1", status="pruned")])
        _, dead = lats._tree_leads_and_dead(t)
        self.assertEqual(len(dead), 1)


class TestTargetSig(unittest.TestCase):
    def test_extracts_endpoint_and_param(self):
        n = _node("a", "error_leak", "-sS 'http://lab/total_loan_payments?principal={{7}}'")
        self.assertIn("/total_loan_payments", lats._target_sig(n))
        self.assertIn("principal", lats._target_sig(n))

    def test_safe_on_empty_or_nondict_args(self):
        n = ExploitTreeNode(id="a", parent_id="root", tool_name="execute_curl", tool_args=None)
        self.assertEqual(lats._target_sig(n), "execute_curl")


class TestCrossTreeMergeAndDedup(unittest.TestCase):
    def tearDown(self):
        project_settings._settings = None

    def test_accumulates_and_dedups_across_trees(self):
        st = {}
        t1 = _tree([_node("a", "error_leak", "http://x/api?principal=1", reflection="lead1"),
                    _node("b", "dead_endpoint", "http://x/admin", status="pruned")])
        lats._append_tree_digest(st, t1, "exhausted")
        # tree 2 RE-HITS the same dead /admin + adds a new dead + a new lead
        t2 = _tree([_node("c", "dead_endpoint", "http://x/admin", status="pruned"),
                    _node("d", "dead_endpoint", "http://x/login", status="pruned"),
                    _node("e", "boolean_differential", "http://x/q?id=1")])
        lats._append_tree_digest(st, t2, "budget_exhausted")
        dead = st["_lats_dead"]
        # /admin recorded ONCE despite two trees hitting it
        self.assertEqual(sum("/admin" in d for d in dead), 1)
        self.assertTrue(any("/login" in d for d in dead))
        self.assertEqual(len(st["_lats_leads"]), 2)     # error_leak + boolean_differential
        self.assertEqual(len(st["_lats_tree_digest"]), 2)   # per-tree narrative retained

    def test_third_tree_inherits_the_merged_union(self):
        st = {}
        lats._append_tree_digest(st, _tree([_node("a", "dead_endpoint", "http://x/admin",
                                                  status="pruned")]), "exhausted")
        lats._append_tree_digest(st, _tree([_node("b", "dead_endpoint", "http://x/login",
                                                  status="pruned"),
                                            _node("c", "error_leak", "http://x/api?p=1",
                                                  reflection="hot")]), "exhausted")
        rendered = lats._prior_tree_summaries(st)       # what tree 3 sees
        self.assertIn("RULED OUT", rendered)
        self.assertIn("/admin", rendered)               # from tree 1
        self.assertIn("/login", rendered)               # from tree 2
        self.assertIn("CONFIRMED LEADS", rendered)
        self.assertIn("error_leak", rendered)           # from tree 2
        # /admin appears exactly once in the merged view (no per-tree repetition)
        self.assertEqual(rendered.count("/admin"), 1)

    def test_stores_are_capped(self):
        project_settings._settings = dict(project_settings.DEFAULT_AGENT_SETTINGS)
        project_settings._settings["LATS_DIGEST_MAX"] = 2   # cap = 2 -> merged cap 8
        st = {}
        for i in range(20):
            lats._append_tree_digest(st, _tree([_node(f"n{i}", "dead_endpoint",
                                    f"http://x/p{i}", status="pruned")]), "exhausted")
        self.assertLessEqual(len(st["_lats_tree_digest"]), 2)
        self.assertLessEqual(len(st["_lats_dead"]), 8)


class TestRenderAndCompat(unittest.TestCase):
    def test_render_labels_leads_and_ruled_out_as_directives(self):
        st = {"_lats_leads": ["error_leak @ /api?p (weaponize)"],
              "_lats_dead": ["dead_endpoint @ /admin"], "_lats_tree_digest": []}
        out = lats._prior_tree_summaries(st)
        self.assertIn("build on these", out.lower())
        self.assertIn("do NOT re-attempt", out)

    def test_falls_back_to_trace_when_no_digest(self):
        st = {"_lats_tree_digest": None, "_lats_leads": None, "_lats_dead": None,
              "execution_trace": [{"tool_name": "lats_search", "tool_output": "TRACE-X"}]}
        self.assertIn("TRACE-X", lats._prior_tree_summaries(st))

    def test_foothold_tag_and_byte_ledger_still_populated(self):
        st = {}
        t = _tree([_node("a", "exploit_confirmed", "http://x/api?p=1", status="terminal",
                         succ=True)])
        lats._append_tree_digest(st, t, "terminal_success")
        self.assertIn("FOOTHOLD", st["_lats_tree_digest"][0])
        self.assertTrue(st["_lats_probe_ledger"])       # hard dedup ledger unchanged

    def test_new_state_fields_declared(self):
        for k in ("_lats_leads", "_lats_dead", "_lats_tree_digest"):
            self.assertIn(k, AgentState.__annotations__)

    def test_lead_and_dead_class_sets_are_valid(self):
        self.assertTrue(lats._LEAD_CLASSES.issubset(lats.RESPONSE_CLASSES))
        self.assertTrue(lats._DEAD_CLASSES.issubset(lats.RESPONSE_CLASSES))
        self.assertFalse(lats._LEAD_CLASSES & lats._DEAD_CLASSES)   # disjoint


if __name__ == "__main__":
    unittest.main(verbosity=2)
