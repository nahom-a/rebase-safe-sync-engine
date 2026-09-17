// Computes the size-bound right-hand side for a given ground-truth mutation set.
//
//   bytes <= floor(2.4 * (net content bytes) + 48 * (net touched node count) + 128)
//
// "net content bytes" is the serialized byte length of the payload
// in the canonically compacted mutation set. Redundant field overwrites,
// transient insertions destroyed within the same batch, and intermediate moves
// are collapsed to their net effect.
// For inserted subtrees, content bytes and touched nodes encompass all
// descendants within the inserted tree.
// delete and move contribute 0 content bytes but still count the node toward
// the touched-node count.

function byteLen(s) {
  return Buffer.byteLength(s, "utf8");
}

function subtreeContent(node) {
  let bytes = byteLen(JSON.stringify({ type: node.type, fields: node.fields || {} }));
  for (const c of node.children || []) {
    bytes += subtreeContent(c);
  }
  return bytes;
}

function collectSubtreeIds(node, set) {
  set.add(node.id);
  for (const c of node.children || []) {
    collectSubtreeIds(c, set);
  }
}

function canonicalNetDiff(mutations) {
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

export function contentBytesOf(mutation) {
  switch (mutation.op) {
    case "insert":
      return subtreeContent(mutation.node);
    case "setField":
      return byteLen(mutation.field) + byteLen(JSON.stringify(mutation.value));
    case "delete":
    case "move":
      return 0;
    default:
      throw new Error(`unknown mutation op: ${mutation.op}`);
  }
}

export function touchedNodeId(mutation) {
  switch (mutation.op) {
    case "insert":
      return mutation.node.id;
    case "delete":
    case "move":
    case "setField":
      return mutation.nodeId;
    default:
      throw new Error(`unknown mutation op: ${mutation.op}`);
  }
}

export function measureBound(mutations) {
  const compacted = canonicalNetDiff(mutations);
  let contentBytes = 0;
  const touched = new Set();
  for (const m of compacted) {
    if (m.op === "insert") {
      contentBytes += subtreeContent(m.node);
      collectSubtreeIds(m.node, touched);
      if (m.parentId) touched.add(m.parentId);
    } else if (m.op === "setField") {
      contentBytes += byteLen(m.field) + byteLen(JSON.stringify(m.value));
      touched.add(m.nodeId);
    } else if (m.op === "delete") {
      touched.add(m.nodeId);
    } else if (m.op === "move") {
      touched.add(m.nodeId);
      if (m.newParentId) touched.add(m.newParentId);
    }
  }
  return Math.floor(2.4 * contentBytes + 48 * touched.size + 128);
}
