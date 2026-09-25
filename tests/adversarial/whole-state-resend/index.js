// Direction A, wrong design #4: whole-state resend.
//
// Reuses the reference codec's correct identity-anchored semantics to
// compute what the resulting state should be, then serializes the ENTIRE
// resulting tree (known and preserved content merged in correct order)
// every single call instead of an incremental delta. Round-trips perfectly
// - it is not a correctness bug - but wire size is O(total tree size)
// regardless of how small the actual change was, so it fails the per-delta
// size bound on any non-trivial tree.

import { cloneTree, findNode, findParent, subtreeIds } from "../model/tree.js";
import { applyMutation } from "../model/mutate.js";
import { schema as v1 } from "../model/schema.v1.js";
import { schema as v2 } from "../model/schema.v2.js";
import { schema as v3 } from "../model/schema.v3.js";

const SCHEMAS = { 1: v1, 2: v2, 3: v3 };

// Inlined copy of the reference codec's identity-anchored encode/decode
// (see solution/fix/index.js for the full design rationale). This cheat
// needs a CORRECT baseline codec to compute what the resulting state
// should be before it resends the whole thing, and it cannot import
// solution/fix/index.js directly - that file is mounted as this cheat's
// own /app/codec/index.js when this attempt runs, so importing it would
// be circular. Duplicating the logic here (rather than pointing at a
// nonexistent sibling module) keeps the fixture runnable standalone.
function schemaFor(version) {
  const s = SCHEMAS[version];
  if (!s) throw new Error(`unknown schema version: ${version}`);
  return s;
}

function emptyResidue() {
  return { fields: {}, nodes: {} };
}

function cloneResidue(r) {
  if (!r) return emptyResidue();
  return {
    fields: Object.fromEntries(Object.entries(r.fields || {}).map(([k, v]) => [k, { ...v }])),
    nodes: Object.fromEntries(
      Object.entries(r.nodes || {}).map(([k, v]) => [
        k,
        { parentId: v.parentId, beforeId: v.beforeId, blob: cloneTree(v.blob) },
      ])
    ),
  };
}

function normalizeRef(baseline) {
  if (baseline && baseline.tree) {
    return { tree: cloneTree(baseline.tree), residue: cloneResidue(baseline.residue) };
  }
  return { tree: cloneTree(baseline), residue: emptyResidue() };
}

function isKnownEnumOrPlain(fieldSchema, value) {
  if (!fieldSchema) return false;
  if (fieldSchema.type === "enum") return fieldSchema.values.includes(value);
  return true;
}

function cascadeDeleteResidue(tree, residue, nodeId) {
  const node = findNode(tree, nodeId);
  if (!node) return;
  const parent = findParent(tree, nodeId);
  const siblings = parent.children;
  const idx = siblings.findIndex((c) => c.id === nodeId);
  const successor = idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1].id : null;
  for (const entry of Object.values(residue.nodes)) {
    if (entry.beforeId === nodeId) entry.beforeId = successor;
  }
  const removedIds = new Set(subtreeIds(node));
  for (const id of removedIds) delete residue.fields[id];
  for (const id of Object.keys(residue.nodes)) {
    if (removedIds.has(residue.nodes[id].parentId)) delete residue.nodes[id];
  }
}

function cascadeMoveResidueAnchors(tree, residue, nodeId) {
  const parent = findParent(tree, nodeId);
  if (!parent) return;
  const siblings = parent.children;
  const idx = siblings.findIndex((c) => c.id === nodeId);
  const successor = idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1].id : null;
  for (const entry of Object.values(residue.nodes)) {
    if (entry.beforeId === nodeId) entry.beforeId = successor;
  }
}

function convertAuthored(tree, m) {
  switch (m.op) {
    case "insert": {
      const parent = findNode(tree, m.parentId);
      const beforeId = m.index >= parent.children.length ? null : parent.children[m.index].id;
      return { op: "insert", parentId: m.parentId, beforeId, node: m.node };
    }
    case "delete":
      return { op: "delete", nodeId: m.nodeId };
    case "move": {
      const oldParent = findParent(tree, m.nodeId);
      const tempChildren = oldParent.children.filter((c) => c.id !== m.nodeId);
      const targetChildren =
        m.newParentId === oldParent.id ? tempChildren : findNode(tree, m.newParentId).children;
      const beforeId = m.newIndex >= targetChildren.length ? null : targetChildren[m.newIndex].id;
      return { op: "move", nodeId: m.nodeId, newParentId: m.newParentId, beforeId };
    }
    case "setField":
      return { op: "setField", nodeId: m.nodeId, field: m.field, value: m.value };
    default:
      throw new Error(`unknown mutation op: ${m.op}`);
  }
}

function refEncode(baseline, mutations, version) {
  const { tree: startTree, residue: startResidue } = normalizeRef(baseline);
  let tree = startTree;
  const residue = startResidue;
  const ops = [];

  for (const m of mutations) {
    ops.push(convertAuthored(tree, m));
    if (m.op === "delete") cascadeDeleteResidue(tree, residue, m.nodeId);
    if (m.op === "move") cascadeMoveResidueAnchors(tree, residue, m.nodeId);
    tree = applyMutation(tree, m);
  }

  for (const entry of Object.values(residue.nodes)) {
    ops.push({ op: "insert", parentId: entry.parentId, beforeId: entry.beforeId, node: entry.blob });
  }
  for (const [id, fields] of Object.entries(residue.fields)) {
    for (const [field, value] of Object.entries(fields)) {
      ops.push({ op: "setField", nodeId: id, field, value });
    }
  }

  return new TextEncoder().encode(JSON.stringify({ v: version, ops }));
}

function insertRawRef(tree, residue, schema, parentId, beforeId, rawNode) {
  const typeInfo = schema.nodeTypes[rawNode.type];
  const parent = findNode(tree, parentId);
  if (!typeInfo) {
    if (!parent) return;
    residue.nodes[rawNode.id] = { parentId, beforeId, blob: cloneTree(rawNode) };
    return;
  }
  const known = {};
  const unknown = {};
  for (const [k, v] of Object.entries(rawNode.fields)) {
    const f = typeInfo.fields[k];
    if (isKnownEnumOrPlain(f, v)) known[k] = v;
    else unknown[k] = v;
  }
  const newNode = { id: rawNode.id, type: rawNode.type, fields: known, children: [] };
  if (!parent) return;
  const idx = beforeId === null ? parent.children.length : parent.children.findIndex((c) => c.id === beforeId);
  parent.children.splice(idx < 0 ? parent.children.length : idx, 0, newNode);
  if (Object.keys(unknown).length) {
    residue.fields[rawNode.id] = { ...(residue.fields[rawNode.id] || {}), ...unknown };
  }
  const rawChildren = rawNode.children;
  for (let i = 0; i < rawChildren.length; i++) {
    let nextKnownId = null;
    for (let j = i + 1; j < rawChildren.length; j++) {
      if (schema.nodeTypes[rawChildren[j].type]) {
        nextKnownId = rawChildren[j].id;
        break;
      }
    }
    insertRawRef(tree, residue, schema, rawNode.id, nextKnownId, rawChildren[i]);
  }
}

function deleteRawRef(tree, residue, nodeId) {
  const node = findNode(tree, nodeId);
  if (node) {
    cascadeDeleteResidue(tree, residue, nodeId);
    const parent = findParent(tree, nodeId);
    const idx = parent.children.findIndex((c) => c.id === nodeId);
    parent.children.splice(idx, 1);
    return;
  }
  if (residue.nodes[nodeId]) {
    const removed = residue.nodes[nodeId];
    for (const entry of Object.values(residue.nodes)) {
      if (entry.beforeId === nodeId) entry.beforeId = removed.beforeId;
    }
    delete residue.nodes[nodeId];
  }
}

function moveRawRef(tree, residue, nodeId, newParentId, beforeId) {
  const node = findNode(tree, nodeId);
  if (!node) {
    if (residue.nodes[nodeId]) {
      residue.nodes[nodeId].parentId = newParentId;
      residue.nodes[nodeId].beforeId = beforeId;
    }
    return;
  }
  cascadeMoveResidueAnchors(tree, residue, nodeId);
  const oldParent = findParent(tree, nodeId);
  const oldIdx = oldParent.children.findIndex((c) => c.id === nodeId);
  oldParent.children.splice(oldIdx, 1);
  const newParent = findNode(tree, newParentId);
  const insertIdx = beforeId === null ? newParent.children.length : newParent.children.findIndex((c) => c.id === beforeId);
  newParent.children.splice(insertIdx < 0 ? newParent.children.length : insertIdx, 0, node);
}

function setFieldRawRef(tree, residue, schema, nodeId, field, value) {
  const node = findNode(tree, nodeId);
  if (node) {
    const typeInfo = schema.nodeTypes[node.type];
    const f = typeInfo && typeInfo.fields[field];
    if (isKnownEnumOrPlain(f, value)) {
      node.fields[field] = value;
      if (residue.fields[nodeId]) delete residue.fields[nodeId][field];
    } else {
      residue.fields[nodeId] = { ...(residue.fields[nodeId] || {}), [field]: value };
    }
    return;
  }
  if (residue.nodes[nodeId]) {
    residue.nodes[nodeId].blob.fields[field] = value;
  }
}

function refDecode(baseline, bytes, version) {
  const schema = schemaFor(version);
  const { tree: startTree, residue: startResidue } = normalizeRef(baseline);
  let tree = startTree;
  const residue = startResidue;
  const { ops } = JSON.parse(new TextDecoder().decode(bytes));

  for (const op of ops) {
    switch (op.op) {
      case "insert":
        insertRawRef(tree, residue, schema, op.parentId, op.beforeId, op.node);
        break;
      case "delete":
        deleteRawRef(tree, residue, op.nodeId);
        break;
      case "move":
        moveRawRef(tree, residue, op.nodeId, op.newParentId, op.beforeId);
        break;
      case "setField":
        setFieldRawRef(tree, residue, schema, op.nodeId, op.field, op.value);
        break;
      default:
        throw new Error(`unknown wire op: ${op.op}`);
    }
  }

  return { tree, residue };
}

function mergeWithOrder(tree, residue) {
  const merged = cloneTree(tree);
  for (const [id, fields] of Object.entries(residue.fields || {})) {
    const node = findNode(merged, id);
    if (node) Object.assign(node.fields, fields);
  }
  for (const entry of Object.values(residue.nodes || {})) {
    const parent = findNode(merged, entry.parentId);
    if (!parent) continue;
    const idx = entry.beforeId === null ? parent.children.length : parent.children.findIndex((c) => c.id === entry.beforeId);
    parent.children.splice(idx < 0 ? parent.children.length : idx, 0, cloneTree(entry.blob));
  }
  return merged;
}

export function encode(baseline, mutations, version) {
  const refBytes = refEncode(baseline, mutations, version);
  const { tree, residue } = refDecode(baseline, refBytes, version);
  const merged = mergeWithOrder(tree, residue);
  return new TextEncoder().encode(JSON.stringify(merged));
}

function splitRaw(schema, rawNode, tree, residue, parentId) {
  const typeInfo = schema.nodeTypes[rawNode.type];
  const parent = findNode(tree, parentId);
  if (!typeInfo) {
    residue.nodes[rawNode.id] = { parentId, blob: cloneTree(rawNode) };
    return;
  }
  const known = {};
  const unknown = {};
  for (const [k, v] of Object.entries(rawNode.fields)) {
    const f = typeInfo.fields[k];
    const ok = f && (f.type !== "enum" || f.values.includes(v));
    if (ok) known[k] = v;
    else unknown[k] = v;
  }
  const node = { id: rawNode.id, type: rawNode.type, fields: known, children: [] };
  parent.children.push(node);
  if (Object.keys(unknown).length) residue.fields[rawNode.id] = unknown;
  for (const child of rawNode.children) splitRaw(schema, child, tree, residue, rawNode.id);
}

export function decode(baseline, bytes, version) {
  const schema = SCHEMAS[version];
  const full = JSON.parse(new TextDecoder().decode(bytes));
  const tree = { id: full.id, type: full.type, fields: { ...full.fields }, children: [] };
  const residue = { fields: {}, nodes: {} };
  for (const child of full.children) splitRaw(schema, child, tree, residue, full.id);
  return { tree, residue };
}
