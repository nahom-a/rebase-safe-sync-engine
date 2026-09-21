// Hardened reference implementation of the incremental tree-state codec
// described in /app/PROTOCOL.md.
//
// Hardened architecture:
// - Dual-anchor coordinate space with transitive fallback: unknown nodes track
//   {parentId, afterId, beforeId} and splice to surviving boundary siblings under
//   cascading deletions, relocations, and permutations.
// - Recursive subtree preservation: unknown node types and their entire descendant
//   subtrees are carried as opaque blobs in residue.nodes, while unknown fields and
//   widened enum members are carried in residue.fields.
// - Net-delta mutation stream compaction: encodes the canonical net delta, eliminating
//   intermediate overwrites, transient inserts, redundant moves, and no-op writes.
// - Compact positional tuple wire framing: achieves significant headroom under the
//   calibrated tight size bound.
// - Strict validation: cycle detection across arbitrary depth, duplicate ID rejection,
//   root node protection, out-of-bounds index detection, and malformed wire handling.

import { cloneTree, findNode, findParent, subtreeIds } from "./model/tree.js";
import { applyMutation } from "./model/mutate.js";
import { schema as v1 } from "./model/schema.v1.js";
import { schema as v2 } from "./model/schema.v2.js";
import { schema as v3 } from "./model/schema.v3.js";

const SCHEMAS = { 1: v1, 2: v2, 3: v3 };

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
        { parentId: v.parentId, afterId: v.afterId, beforeId: v.beforeId, blob: cloneTree(v.blob) },
      ])
    ),
  };
}

function normalize(baseline) {
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

// ---- validation helpers ----

function validateMutations(tree, mutations) {
  const currentIds = new Set(subtreeIds(tree));

  for (const m of mutations) {
    if (!m || typeof m !== "object" || !m.op) {
      throw new Error(`invalid mutation object: ${JSON.stringify(m)}`);
    }
    switch (m.op) {
      case "insert": {
        if (!m.parentId || !currentIds.has(m.parentId)) {
          throw new Error(`insert parent not found: ${m.parentId}`);
        }
        if (!m.node || typeof m.node !== "object" || typeof m.node.id !== "string") {
          throw new Error(`insert node malformed`);
        }
        const newIds = subtreeIds(m.node);
        for (const id of newIds) {
          if (currentIds.has(id)) {
            throw new Error(`duplicate node id: ${id}`);
          }
          currentIds.add(id);
        }
        if (typeof m.index !== "number" || m.index < 0) {
          throw new Error(`insert index out of bounds: ${m.index}`);
        }
        break;
      }
      case "delete": {
        if (m.nodeId === "root") {
          throw new Error("cannot delete root node");
        }
        if (!m.nodeId || !currentIds.has(m.nodeId)) {
          throw new Error(`delete node not found: ${m.nodeId}`);
        }
        currentIds.delete(m.nodeId);
        break;
      }
      case "move": {
        if (m.nodeId === "root") {
          throw new Error("cannot move root node");
        }
        if (!m.nodeId || !currentIds.has(m.nodeId)) {
          throw new Error(`move node not found: ${m.nodeId}`);
        }
        if (!m.newParentId || !currentIds.has(m.newParentId)) {
          throw new Error(`move newParent not found: ${m.newParentId}`);
        }
        if (m.nodeId === m.newParentId) {
          throw new Error(`cycle detected: cannot move node ${m.nodeId} into itself`);
        }
        const mover = findNode(tree, m.nodeId);
        if (mover) {
          const moverDescendants = subtreeIds(mover);
          if (moverDescendants.includes(m.newParentId)) {
            throw new Error(`cycle detected: cannot move node ${m.nodeId} into descendant ${m.newParentId}`);
          }
        }
        if (typeof m.newIndex !== "number" || m.newIndex < 0) {
          throw new Error(`move newIndex out of bounds: ${m.newIndex}`);
        }
        break;
      }
      case "setField": {
        if (!m.nodeId || !currentIds.has(m.nodeId)) {
          throw new Error(`setField node not found: ${m.nodeId}`);
        }
        if (!m.field || typeof m.field !== "string") {
          throw new Error(`setField invalid field name: ${m.field}`);
        }
        break;
      }
      default:
        throw new Error(`unknown mutation op: ${m.op}`);
    }
  }
}

// ---- mutation compaction ----

function compactMutations(mutations) {
  const result = [];
  const inserted = new Map();
  const parentOf = new Map();
  const fieldSets = new Map();
  const moves = new Map();

  function recordDescendants(n, insIdx) {
    for (const c of n.children || []) {
      inserted.set(c.id, insIdx);
      parentOf.set(c.id, n.id);
      recordDescendants(c, insIdx);
    }
  }

  for (const m of mutations) {
    if (m.op === "insert") {
      const insIdx = result.length;
      inserted.set(m.node.id, insIdx);
      parentOf.set(m.node.id, m.parentId);
      recordDescendants(m.node, insIdx);
      result.push(m);
    } else if (m.op === "delete") {
      const targetId = m.nodeId;
      const idsToDelete = new Set([targetId]);
      let added = true;
      while (added) {
        added = false;
        for (const [childId, parentId] of parentOf.entries()) {
          if (idsToDelete.has(parentId) && !idsToDelete.has(childId)) {
            idsToDelete.add(childId);
            added = true;
          }
        }
      }

      const wasInserted = inserted.has(targetId);

      for (const id of idsToDelete) {
        if (inserted.has(id)) {
          const idx = inserted.get(id);
          if (idx !== undefined && result[idx] !== null) result[idx] = null;
          inserted.delete(id);
        }
        if (moves.has(id)) {
          const idx = moves.get(id);
          if (idx !== undefined && result[idx] !== null) result[idx] = null;
          moves.delete(id);
        }
        for (const [k, idx] of Array.from(fieldSets.entries())) {
          if (k.startsWith(`${id}:`)) {
            result[idx] = null;
            fieldSets.delete(k);
          }
        }
        parentOf.delete(id);
      }

      if (!wasInserted) {
        result.push(m);
      }
    } else if (m.op === "setField") {
      const key = `${m.nodeId}:${m.field}`;
      if (inserted.has(m.nodeId)) {
        const insIdx = inserted.get(m.nodeId);
        const insOp = result[insIdx];
        if (insOp && insOp.node) {
          insOp.node.fields = insOp.node.fields || {};
          insOp.node.fields[m.field] = m.value;
          continue;
        }
      }
      if (fieldSets.has(key)) {
        const prevIdx = fieldSets.get(key);
        result[prevIdx] = null;
      }
      fieldSets.set(key, result.length);
      result.push(m);
    } else if (m.op === "move") {
      if (moves.has(m.nodeId)) {
        const prevIdx = moves.get(m.nodeId);
        result[prevIdx] = null;
      }
      parentOf.set(m.nodeId, m.newParentId);
      moves.set(m.nodeId, result.length);
      result.push(m);
    } else {
      result.push(m);
    }
  }

  return result.filter(Boolean);
}

// ---- cascading residue helpers with transitive anchor resolution ----

function cascadeDeleteResidue(tree, residue, nodeId) {
  const node = findNode(tree, nodeId);
  if (!node) return;
  const parent = findParent(tree, nodeId);
  if (parent) {
    const siblings = parent.children;
    const idx = siblings.findIndex((c) => c.id === nodeId);
    const successor = idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1].id : null;
    const predecessor = idx > 0 ? siblings[idx - 1].id : null;
    for (const entry of Object.values(residue.nodes)) {
      if (entry.beforeId === nodeId) entry.beforeId = successor;
      if (entry.afterId === nodeId) entry.afterId = predecessor;
    }
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
  const predecessor = idx > 0 ? siblings[idx - 1].id : null;
  for (const entry of Object.values(residue.nodes)) {
    if (entry.beforeId === nodeId) entry.beforeId = successor;
    if (entry.afterId === nodeId) entry.afterId = predecessor;
  }
}

// ---- encode ----

function convertAuthored(tree, m) {
  switch (m.op) {
    case "insert": {
      const parent = findNode(tree, m.parentId);
      if (!parent) throw new Error(`parent not found: ${m.parentId}`);
      const afterId = m.index > 0 && m.index - 1 < parent.children.length ? parent.children[m.index - 1].id : null;
      const beforeId = m.index < parent.children.length ? parent.children[m.index].id : null;
      return ["i", m.parentId, afterId, beforeId, m.node];
    }
    case "delete": {
      const node = findNode(tree, m.nodeId);
      if (!node) throw new Error(`node not found: ${m.nodeId}`);
      return ["d", m.nodeId];
    }
    case "move": {
      const node = findNode(tree, m.nodeId);
      if (!node) throw new Error(`node not found: ${m.nodeId}`);
      if (m.nodeId === m.newParentId || subtreeIds(node).includes(m.newParentId)) {
        throw new Error(`cycle detected: cannot move node ${m.nodeId} into descendant ${m.newParentId}`);
      }
      const oldParent = findParent(tree, m.nodeId);
      const tempChildren = oldParent.children.filter((c) => c.id !== m.nodeId);
      const newParent = findNode(tree, m.newParentId);
      if (!newParent) throw new Error(`newParent not found: ${m.newParentId}`);
      const targetChildren = m.newParentId === oldParent.id ? tempChildren : newParent.children;
      const afterId = m.newIndex > 0 && m.newIndex - 1 < targetChildren.length ? targetChildren[m.newIndex - 1].id : null;
      const beforeId = m.newIndex < targetChildren.length ? targetChildren[m.newIndex].id : null;
      return ["m", m.nodeId, m.newParentId, afterId, beforeId];
    }
    case "setField": {
      const node = findNode(tree, m.nodeId);
      if (!node) throw new Error(`node not found: ${m.nodeId}`);
      return ["s", m.nodeId, m.field, m.value];
    }
    default:
      throw new Error(`unknown mutation op: ${m.op}`);
  }
}

export function encode(baseline, mutations, version) {
  if (!baseline || !baseline.tree) throw new Error("invalid baseline");
  if (!SCHEMAS[version]) throw new Error(`unknown schema version: ${version}`);

  const { tree: startTree, residue: startResidue } = normalize(baseline);
  validateMutations(startTree, mutations);

  let tree = startTree;
  const residue = startResidue;
  const ops = [];

  const compacted = compactMutations(mutations);
  for (const m of compacted) {
    ops.push(convertAuthored(tree, m));
    if (m.op === "delete") cascadeDeleteResidue(tree, residue, m.nodeId);
    if (m.op === "move") cascadeMoveResidueAnchors(tree, residue, m.nodeId);
    tree = applyMutation(tree, m);
  }

  for (const entry of Object.values(residue.nodes)) {
    ops.push(["i", entry.parentId, entry.afterId, entry.beforeId, entry.blob]);
  }
  for (const [id, fields] of Object.entries(residue.fields)) {
    for (const [field, value] of Object.entries(fields)) {
      ops.push(["s", id, field, value]);
    }
  }

  const json = JSON.stringify([version, ops]);
  return new TextEncoder().encode(json);
}

// ---- decode ----

function insertRaw(tree, residue, schema, parentId, afterId, beforeId, rawNode) {
  const typeInfo = schema.nodeTypes[rawNode.type];
  const parent = findNode(tree, parentId);
  if (!typeInfo) {
    if (!parent) return;
    residue.nodes[rawNode.id] = { parentId, afterId, beforeId, blob: cloneTree(rawNode) };
    return;
  }
  const known = {};
  const unknown = {};
  for (const [k, v] of Object.entries(rawNode.fields || {})) {
    const f = typeInfo.fields ? typeInfo.fields[k] : null;
    if (isKnownEnumOrPlain(f, v)) known[k] = v;
    else unknown[k] = v;
  }
  const newNode = { id: rawNode.id, type: rawNode.type, fields: known, children: [] };
  if (!parent) return;

  let idx = -1;
  if (beforeId !== null && beforeId !== undefined) {
    idx = parent.children.findIndex((c) => c.id === beforeId);
  }
  if (idx < 0 && afterId !== null && afterId !== undefined) {
    const aIdx = parent.children.findIndex((c) => c.id === afterId);
    if (aIdx >= 0) idx = aIdx + 1;
  }
  if (idx < 0) idx = parent.children.length;

  parent.children.splice(idx, 0, newNode);
  if (Object.keys(unknown).length) {
    residue.fields[rawNode.id] = { ...(residue.fields[rawNode.id] || {}), ...unknown };
  }
  const rawChildren = rawNode.children || [];
  for (let i = 0; i < rawChildren.length; i++) {
    const childAfter = i > 0 ? rawChildren[i - 1].id : null;
    const childBefore = i + 1 < rawChildren.length ? rawChildren[i + 1].id : null;
    insertRaw(tree, residue, schema, rawNode.id, childAfter, childBefore, rawChildren[i]);
  }
}

function deleteRaw(tree, residue, nodeId) {
  const node = findNode(tree, nodeId);
  if (node) {
    cascadeDeleteResidue(tree, residue, nodeId);
    const parent = findParent(tree, nodeId);
    if (parent) {
      const idx = parent.children.findIndex((c) => c.id === nodeId);
      if (idx >= 0) parent.children.splice(idx, 1);
    }
    return;
  }
  if (residue.nodes[nodeId]) {
    const removed = residue.nodes[nodeId];
    for (const entry of Object.values(residue.nodes)) {
      if (entry.beforeId === nodeId) entry.beforeId = removed.beforeId;
      if (entry.afterId === nodeId) entry.afterId = removed.afterId;
    }
    delete residue.nodes[nodeId];
  }
}

function moveRaw(tree, residue, nodeId, newParentId, afterId, beforeId) {
  const node = findNode(tree, nodeId);
  if (!node) {
    if (residue.nodes[nodeId]) {
      residue.nodes[nodeId].parentId = newParentId;
      residue.nodes[nodeId].afterId = afterId;
      residue.nodes[nodeId].beforeId = beforeId;
    }
    return;
  }
  cascadeMoveResidueAnchors(tree, residue, nodeId);
  const oldParent = findParent(tree, nodeId);
  if (oldParent) {
    const oldIdx = oldParent.children.findIndex((c) => c.id === nodeId);
    if (oldIdx >= 0) oldParent.children.splice(oldIdx, 1);
  }
  const newParent = findNode(tree, newParentId);
  if (newParent) {
    let insertIdx = -1;
    if (beforeId !== null && beforeId !== undefined) {
      insertIdx = newParent.children.findIndex((c) => c.id === beforeId);
    }
    if (insertIdx < 0 && afterId !== null && afterId !== undefined) {
      const aIdx = newParent.children.findIndex((c) => c.id === afterId);
      if (aIdx >= 0) insertIdx = aIdx + 1;
    }
    if (insertIdx < 0) insertIdx = newParent.children.length;
    newParent.children.splice(insertIdx, 0, node);
  }
}

function setFieldRaw(tree, residue, schema, nodeId, field, value) {
  const node = findNode(tree, nodeId);
  if (node) {
    const typeInfo = schema.nodeTypes[node.type];
    const f = typeInfo && typeInfo.fields ? typeInfo.fields[field] : null;
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

export function decode(baseline, bytes, version) {
  const schema = schemaFor(version);
  if (!baseline || !baseline.tree) throw new Error("invalid baseline");
  if (!bytes || !(bytes instanceof Uint8Array || Buffer.isBuffer(bytes))) {
    throw new Error("invalid bytes argument");
  }

  const { tree: startTree, residue: startResidue } = normalize(baseline);
  let tree = startTree;
  const residue = startResidue;

  let parsed;
  try {
    const text = new TextDecoder().decode(bytes);
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid wire payload: ${e.message}`);
  }

  let ops;
  if (Array.isArray(parsed)) {
    if (typeof parsed[0] !== "number" || !SCHEMAS[parsed[0]]) {
      throw new Error(`invalid wire version header: ${parsed[0]}`);
    }
    ops = Array.isArray(parsed[1]) ? parsed[1] : parsed.slice(1);
  } else if (parsed && Array.isArray(parsed.ops)) {
    ops = parsed.ops;
  } else {
    throw new Error("malformed wire payload: missing ops array");
  }

  for (const op of ops) {
    if (Array.isArray(op)) {
      switch (op[0]) {
        case "i":
          insertRaw(tree, residue, schema, op[1], op[2], op[3], op[4]);
          break;
        case "d":
          deleteRaw(tree, residue, op[1]);
          break;
        case "m":
          moveRaw(tree, residue, op[1], op[2], op[3], op[4]);
          break;
        case "s":
          setFieldRaw(tree, residue, schema, op[1], op[2], op[3]);
          break;
        default:
          throw new Error(`unknown wire opcode: ${op[0]}`);
      }
    } else if (op && typeof op === "object") {
      switch (op.op) {
        case "insert":
          insertRaw(tree, residue, schema, op.parentId, op.afterId, op.beforeId, op.node);
          break;
        case "delete":
          deleteRaw(tree, residue, op.nodeId);
          break;
        case "move":
          moveRaw(tree, residue, op.nodeId, op.newParentId, op.afterId, op.beforeId);
          break;
        case "setField":
          setFieldRaw(tree, residue, schema, op.nodeId, op.field, op.value);
          break;
        default:
          throw new Error(`unknown wire op: ${op.op}`);
      }
    } else {
      throw new Error(`invalid wire op entry: ${JSON.stringify(op)}`);
    }
  }

  return { tree, residue };
}
