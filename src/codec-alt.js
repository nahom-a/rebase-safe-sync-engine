// Direction B, second independent implementation: materially different framing
// and residue architecture from the primary reference.
//
// Key structural differences:
// 1. Wire representation: integer opcodes (1=insert, 2=delete, 3=move, 4=setField)
//    instead of 1-character string opcodes ("i", "d", "m", "s"), packaged as [version, ops].
// 2. Residue storage model: flat arrays { fields: Array<{nodeId, field, value}>, nodes: Array<{id, parentId, afterId, beforeId, blob}> }
//    rather than nested dictionaries/maps keyed by node ID.
// 3. Anchor resolution priority: prioritizes afterId (preceding sibling) over beforeId,
//    with fallback to beforeId when afterId is absent or deleted.
// 4. Carried residue sequencing: carried residue ops are placed before authored edits
//    in the wire stream.
// 5. Mutation compaction: independent net-delta computation coalescing intermediate states.

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

const OP_INSERT = 1;
const OP_DELETE = 2;
const OP_MOVE = 3;
const OP_SET_FIELD = 4;

function emptyResidue() {
  return { fields: [], nodes: [] };
}

function cloneResidue(r) {
  if (!r) return emptyResidue();
  const fields = Array.isArray(r.fields) ? r.fields.map((f) => ({ ...f })) : [];
  const nodes = Array.isArray(r.nodes)
    ? r.nodes.map((n) => ({ id: n.id, parentId: n.parentId, afterId: n.afterId, beforeId: n.beforeId, blob: cloneTree(n.blob) }))
    : [];
  return { fields, nodes };
}

function normalize(baseline) {
  if (baseline && baseline.tree) return { tree: cloneTree(baseline.tree), residue: cloneResidue(baseline.residue) };
  return { tree: cloneTree(baseline), residue: emptyResidue() };
}

function isKnownEnumOrPlain(fieldSchema, value) {
  if (!fieldSchema) return false;
  if (fieldSchema.type === "enum") return fieldSchema.values.includes(value);
  return true;
}

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

function setUnknownField(residue, nodeId, field, value) {
  const existing = residue.fields.find((f) => f.nodeId === nodeId && f.field === field);
  if (existing) existing.value = value;
  else residue.fields.push({ nodeId, field, value });
}

function unsetUnknownField(residue, nodeId, field) {
  residue.fields = residue.fields.filter((f) => !(f.nodeId === nodeId && f.field === field));
}

function cascadeDeleteResidue(tree, residue, nodeId) {
  const node = findNode(tree, nodeId);
  const parent = node ? findParent(tree, nodeId) : null;
  let predecessor = null;
  let successor = null;
  if (parent) {
    const siblings = parent.children;
    const idx = siblings.findIndex((c) => c.id === nodeId);
    if (idx > 0) predecessor = siblings[idx - 1].id;
    if (idx >= 0 && idx + 1 < siblings.length) successor = siblings[idx + 1].id;
  }

  for (const entry of residue.nodes) {
    if (entry.afterId === nodeId) entry.afterId = predecessor;
    if (entry.beforeId === nodeId) entry.beforeId = successor;
  }

  const removedIds = new Set(node ? subtreeIds(node) : [nodeId]);
  residue.fields = residue.fields.filter((f) => !removedIds.has(f.nodeId));
  residue.nodes = residue.nodes.filter((n) => !removedIds.has(n.id) && !removedIds.has(n.parentId));
}

function cascadeMoveResidueAnchors(tree, residue, nodeId) {
  const parent = findParent(tree, nodeId);
  if (!parent) return;
  const siblings = parent.children;
  const idx = siblings.findIndex((c) => c.id === nodeId);
  const predecessor = idx > 0 ? siblings[idx - 1].id : null;
  const successor = idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1].id : null;
  for (const entry of residue.nodes) {
    if (entry.afterId === nodeId) entry.afterId = predecessor;
    if (entry.beforeId === nodeId) entry.beforeId = successor;
  }
}

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

function convertAuthored(tree, m) {
  switch (m.op) {
    case "insert": {
      const parent = findNode(tree, m.parentId);
      if (!parent) throw new Error(`parent node not found: ${m.parentId}`);
      const idx = Math.min(m.index, parent.children.length);
      const afterId = idx <= 0 ? null : parent.children[idx - 1].id;
      const beforeId = idx < parent.children.length ? parent.children[idx].id : null;
      return [OP_INSERT, m.parentId, afterId, beforeId, m.node];
    }
    case "delete": {
      const node = findNode(tree, m.nodeId);
      if (!node) throw new Error(`node not found for delete: ${m.nodeId}`);
      return [OP_DELETE, m.nodeId];
    }
    case "move": {
      const node = findNode(tree, m.nodeId);
      if (!node) throw new Error(`node not found for move: ${m.nodeId}`);
      if (m.nodeId === m.newParentId || subtreeIds(node).includes(m.newParentId)) {
        throw new Error(`cycle detected: cannot move node ${m.nodeId} into its own descendant ${m.newParentId}`);
      }
      const oldParent = findParent(tree, m.nodeId);
      const targetParent = findNode(tree, m.newParentId);
      if (!targetParent) throw new Error(`target parent not found for move: ${m.newParentId}`);
      const tempChildren = oldParent.id === targetParent.id
        ? oldParent.children.filter((c) => c.id !== m.nodeId)
        : targetParent.children;
      const idx = Math.min(m.newIndex, tempChildren.length);
      const afterId = idx <= 0 ? null : tempChildren[idx - 1].id;
      const beforeId = idx < tempChildren.length ? tempChildren[idx].id : null;
      return [OP_MOVE, m.nodeId, m.newParentId, afterId, beforeId];
    }
    case "setField": {
      const node = findNode(tree, m.nodeId);
      if (!node) throw new Error(`node not found for setField: ${m.nodeId}`);
      return [OP_SET_FIELD, m.nodeId, m.field, m.value];
    }
    default:
      throw new Error(`unknown mutation op: ${m.op}`);
  }
}

export function encode(baseline, mutations, version) {
  if (!baseline || !baseline.tree) throw new Error("invalid baseline");
  if (!Array.isArray(mutations)) throw new Error("mutations must be an array");

  const { tree: startTree, residue } = normalize(baseline);
  validateMutations(startTree, mutations);

  let tree = startTree;
  const authored = [];

  const compacted = compactMutations(mutations);
  for (const m of compacted) {
    authored.push(convertAuthored(tree, m));
    if (m.op === "delete") cascadeDeleteResidue(tree, residue, m.nodeId);
    if (m.op === "move") cascadeMoveResidueAnchors(tree, residue, m.nodeId);
    tree = applyMutation(tree, m);
  }

  const carried = [];
  for (const entry of residue.nodes) {
    carried.push([OP_INSERT, entry.parentId, entry.afterId, entry.beforeId, entry.blob]);
  }
  for (const f of residue.fields) {
    carried.push([OP_SET_FIELD, f.nodeId, f.field, f.value]);
  }

  // Authored edits placed before carried residue ops so newly authored gap insertions sort before preserved content
  const wireOps = [...authored, ...carried];
  const payload = [version, wireOps];
  return new TextEncoder().encode(JSON.stringify(payload));
}

function insertRaw(tree, residue, schema, parentId, afterId, beforeId, rawNode) {
  const typeInfo = schema.nodeTypes[rawNode.type];
  const parent = findNode(tree, parentId);
  if (!typeInfo) {
    if (!parent) return;
    const existingIdx = residue.nodes.findIndex((n) => n.id === rawNode.id);
    const entry = { id: rawNode.id, parentId, afterId, beforeId, blob: cloneTree(rawNode) };
    if (existingIdx >= 0) residue.nodes[existingIdx] = entry;
    else residue.nodes.push(entry);
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

  // Codec B anchor priority: afterId first, then beforeId
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
  for (const [k, v] of Object.entries(unknown)) {
    setUnknownField(residue, rawNode.id, k, v);
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
  const resIdx = residue.nodes.findIndex((n) => n.id === nodeId);
  if (resIdx >= 0) {
    const removed = residue.nodes[resIdx];
    for (const entry of residue.nodes) {
      if (entry.afterId === nodeId) entry.afterId = removed.afterId;
      if (entry.beforeId === nodeId) entry.beforeId = removed.beforeId;
    }
    residue.nodes.splice(resIdx, 1);
  }
}

function moveRaw(tree, residue, nodeId, newParentId, afterId, beforeId) {
  const node = findNode(tree, nodeId);
  if (!node) {
    const resNode = residue.nodes.find((n) => n.id === nodeId);
    if (resNode) {
      resNode.parentId = newParentId;
      resNode.afterId = afterId;
      resNode.beforeId = beforeId;
    }
    return;
  }
  cascadeMoveResidueAnchors(tree, residue, nodeId);
  const oldParent = findParent(tree, nodeId);
  if (oldParent) {
    const idx = oldParent.children.findIndex((c) => c.id === nodeId);
    if (idx >= 0) oldParent.children.splice(idx, 1);
  }
  const newParent = findNode(tree, newParentId);
  if (!newParent) return;

  let idx = -1;
  if (beforeId !== null && beforeId !== undefined) {
    idx = newParent.children.findIndex((c) => c.id === beforeId);
  }
  if (idx < 0 && afterId !== null && afterId !== undefined) {
    const aIdx = newParent.children.findIndex((c) => c.id === afterId);
    if (aIdx >= 0) idx = aIdx + 1;
  }
  if (idx < 0) idx = newParent.children.length;

  newParent.children.splice(idx, 0, node);
}

function setFieldRaw(tree, residue, schema, nodeId, field, value) {
  const node = findNode(tree, nodeId);
  if (node) {
    const typeInfo = schema.nodeTypes[node.type];
    const f = typeInfo && typeInfo.fields ? typeInfo.fields[field] : null;
    if (isKnownEnumOrPlain(f, value)) {
      node.fields[field] = value;
      unsetUnknownField(residue, nodeId, field);
    } else {
      setUnknownField(residue, nodeId, field, value);
    }
    return;
  }
  const resNode = residue.nodes.find((n) => n.id === nodeId);
  if (resNode && resNode.blob && resNode.blob.fields) {
    resNode.blob.fields[field] = value;
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
      const code = op[0];
      if (code === OP_INSERT || code === "i") {
        insertRaw(tree, residue, schema, op[1], op[2], op[3], op[4]);
      } else if (code === OP_DELETE || code === "d") {
        deleteRaw(tree, residue, op[1]);
      } else if (code === OP_MOVE || code === "m") {
        moveRaw(tree, residue, op[1], op[2], op[3], op[4]);
      } else if (code === OP_SET_FIELD || code === "s") {
        setFieldRaw(tree, residue, schema, op[1], op[2], op[3]);
      } else {
        throw new Error(`unknown opcode: ${code}`);
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
