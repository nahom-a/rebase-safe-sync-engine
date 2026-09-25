// Node model: { id, type, fields, children }
// - id: string, stable, assigned once, never reused.
// - type: string, a node type name defined by some schema version.
// - fields: plain object of field-name -> value.
// - children: ordered array of child nodes (same shape), order is meaningful.

export function makeNode(id, type, fields = {}, children = []) {
  return { id, type, fields: { ...fields }, children: children.map(cloneTree) };
}

export function cloneTree(node) {
  return {
    id: node.id,
    type: node.type,
    fields: { ...node.fields },
    children: node.children.map(cloneTree),
  };
}

export function findNode(root, id) {
  if (root.id === id) return root;
  for (const c of root.children) {
    const found = findNode(c, id);
    if (found) return found;
  }
  return null;
}

// Returns the parent node of `id`, or null if `id` is the root's own id,
// or undefined if `id` does not exist anywhere in the tree.
export function findParent(root, id, parent = null) {
  if (root.id === id) return parent;
  for (const c of root.children) {
    const found = findParent(c, id, root);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function walk(root, fn) {
  fn(root);
  for (const c of root.children) walk(c, fn);
}

// All descendant ids of a node, including the node's own id.
export function subtreeIds(root) {
  const ids = [];
  walk(root, (n) => ids.push(n.id));
  return ids;
}
