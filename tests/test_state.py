"""Verifier for rebase-safe-codec. Asserts on JSON report from runner.mjs."""
import json
import os
import pytest

REPORT_PATH = os.environ["VERIFIER_REPORT"]


@pytest.fixture(scope="module")
def report():
    with open(REPORT_PATH, "r", encoding="utf-8") as f:
        lines = [line for line in f.read().splitlines() if line.strip()]
    assert lines, f"{REPORT_PATH} is empty - runner.mjs produced no output"
    return json.loads(lines[-1])


def _names(entries, *substrings):
    return [e for e in entries if any(s in e["name"] for s in substrings)]


def _assert_all_ok(entries, label):
    failed = [e for e in entries if not e["ok"]]
    assert not failed, f"{label}: {len(failed)}/{len(entries)} failed, e.g. {failed[0]['name']}: {failed[0]['failures']}"


def test_exports_exist(report):
    assert report["error"] is None, f"runner error: {report['error']}"
    assert report["exportsOk"] is True, "encode/decode must both be exported as functions"


def test_visible_corpus_passes(report):
    assert len(report["visible"]) >= 25, "visible corpus missing or too small"
    _assert_all_ok(report["visible"], "visible corpus")


def test_held_out_downlevel_preservation(report):
    entries = _names(report["heldOut"], "f1-", "f2-", "f3a-", "f3b-", "f3c-", "f5-")
    assert len(entries) > 0
    _assert_all_ok(entries, "held-out downlevel preservation")


def test_held_out_edit_after_downlevel_reemission(report):
    entries = _names(report["heldOut"], "f1-", "f2-", "f3a-", "f3b-", "f3c-")
    assert len(entries) > 0
    _assert_all_ok(entries, "held-out edit-after-downlevel re-emission/positioning")


def test_held_out_multi_anchor_collapse(report):
    entries = _names(report["heldOut"], "f3c-")
    assert len(entries) > 0
    _assert_all_ok(entries, "held-out multi-anchor deletion and transitive collapse")


def test_held_out_non_resurrection(report):
    entries = _names(report["heldOut"], "f4-")
    assert len(entries) > 0
    _assert_all_ok(entries, "held-out non-resurrection on delete")


def test_held_out_move_carries_unknown(report):
    entries = _names(report["heldOut"], "f5-")
    assert len(entries) > 0
    _assert_all_ok(entries, "held-out move-carries-unknown")


def test_held_out_multihop_chains(report):
    entries = _names(report["heldOut"], "f6-")
    assert len(entries) > 0
    _assert_all_ok(entries, "held-out multi-hop chains (3, 4, 5, 6 hops)")


def test_held_out_sibling_permutations(report):
    entries = _names(report["heldOut"], "f8-")
    assert len(entries) > 0
    _assert_all_ok(entries, "held-out sibling permutations")


def test_held_out_compaction_churn(report):
    entries = _names(report["heldOut"], "f9-")
    assert len(entries) > 0
    _assert_all_ok(entries, "held-out mutation compaction churn")


def test_held_out_nested_subtree(report):
    entries = _names(report["heldOut"], "f10-")
    assert len(entries) > 0
    _assert_all_ok(entries, "held-out nested unknown subtree")


def test_held_out_widened_enum_preservation(report):
    entries = _names(report["heldOut"], "f11-")
    assert len(entries) > 0
    _assert_all_ok(entries, "held-out widened enum preservation")


def test_held_out_transitive_anchor_chains(report):
    entries = _names(report["heldOut"], "f12-")
    assert len(entries) > 0
    _assert_all_ok(entries, "held-out transitive anchor chains")


def test_size_bound_across_held_out(report):
    entries = _names(report["heldOut"], "f7-")
    assert len(entries) > 0
    _assert_all_ok(entries, "size bound on held-out deltas")


def test_size_bound_all_empty_residue_deltas(report):
    sb = report["sizeBoundEmptyResidue"]
    assert sb is not None, "size bound (empty-residue) check did not run"
    assert sb.get("error") is None, f"size bound check errored: {sb.get('error')}"
    assert sb["checked"] >= 200, f"expected >=200 empty-residue deltas checked, got {sb['checked']}"
    assert sb["violations"] == 0, f"{sb['violations']}/{sb['checked']} empty-residue deltas exceeded size bound: {sb.get('examples')}"


def test_determinism(report):
    assert report["determinism"] is True, "identical inputs produced different outputs across two encode calls"


def test_malformed_input_handling(report):
    assert report["malformed"] is True, "encode() with an invalid mutation (nonexistent node, invalid parent, duplicate ID) must throw"


def test_malformed_bytes_decode_handling(report):
    assert report["malformedDecode"] is True, "decode() with bytes not produced by a conforming encode() must throw"


def test_cycle_and_boundary_rejection(report):
    assert report["cycleRejection"] is True, "encode() attempting cycle creation or moving/deleting root must throw"
