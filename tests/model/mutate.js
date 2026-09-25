import { cloneTree, findNode, findParent } from "./tree.js";

// The mutation set. Every mutation is a plain object with an `op` field:
//   { op: "insert", parentId, index, node }
//   { op: "delete", nodeId }
//   { op: "move", nodeId, newParentId, newIndex }
//   { op: "setField", nodeId, field, value }

export function applyMutation(tree, m) {
  const t = cloneTree(tree);
  switch (m.op) {
    case "insert": {
      const parent = findNode(t, m.parentId);
      parent.children.splice(m.index, 0, cloneTree(m.node));
      break;
    }
    case "delete": {
      const parent = findParent(t, m.nodeId);
      if (parent) {
        const idx = parent.children.findIndex((c) => c.id === m.nodeId);
        if (idx >= 0) parent.children.splice(idx, 1);
      }
      break;
    }
    case "move": {
      const parent = findParent(t, m.nodeId);
      const idx = parent.children.findIndex((c) => c.id === m.nodeId);
      const [node] = parent.children.splice(idx, 1);
      const newParent = findNode(t, m.newParentId);
      newParent.children.splice(m.newIndex, 0, node);
      break;
    }
    case "setField": {
      const node = findNode(t, m.nodeId);
      node.fields[m.field] = m.value;
      break;
    }
    default:
      throw new Error(`unknown mutation op: ${m.op}`);
  }
  return t;
}

export function applyMutations(tree, mutations) {
  return mutations.reduce(applyMutation, tree);
}
