// Seeded held-out scenario generator. Verifier-only: never shipped into the
// agent image. Produces scenarios in the same shape run_scenarios.js
// consumes ({ genesis, steps, checks }), so the same interpreter grades both
// the visible and the held-out corpus.
//
// Deliberately over-samples the compositions a random generator would
// otherwise rarely produce (see families F1-F12 below), per PROTOCOL.md's
// hardest requirements: edit-after-downlevel-decode relocation, sibling
// permutations, multi-anchor deletion and transitive collapse, deletion of
// unknown-bearing descendants, moves across subtree boundaries, 3/4/5/6-hop
// chains with concurrent edits, mutation compaction under extreme churn,
// deep 4/5-tier nested unknown subtrees with child items, widened enum
// preservation across multi-peer hops, and transitive unknown-to-unknown
// anchor chains.
//
// Node ids and field values are randomized per instance so a lookup table
// fitted against the visible corpus does not transfer. The generator itself
// is deterministic for a fixed seed: two runs with the same seed produce
// byte-identical corpora.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const rand = mulberry32(seed);
  return {
    float: () => rand(),
    int: (n) => Math.floor(rand() * n),
    pick: (arr) => arr[Math.floor(rand() * arr.length)],
    id: (prefix) => `${prefix}_${Math.floor(rand() * 1e9).toString(36)}`,
    word: () => ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"][Math.floor(rand() * 8)] + Math.floor(rand() * 1000),
  };
}

function genesisWithItems(rng, n) {
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push({ id: `item_${i}_${rng.id("g")}`, type: "item", fields: { label: rng.word(), priority: rng.pick(["low", "med", "high"]) }, children: [] });
  }
  return {
    tree: {
      id: "root",
      type: "root",
      fields: {},
      children: [{ id: "s1", type: "section", fields: { title: rng.word(), status: "open" }, children: items }],
    },
    itemIds: items.map((i) => i.id),
  };
}

let counter = 0;
function nextName(family) {
  counter++;
  return `held-${family}-${String(counter).padStart(4, "0")}`;
}

// F1: edit-after-downlevel, insertion relocates the preserved region.
function genF1(rng) {
  const { tree, itemIds } = genesisWithItems(rng, 5);
  const anchorIdx = 1 + rng.int(itemIds.length - 2);
  const anchorId = itemIds[anchorIdx];

  const style = rng.int(2);
  if (style === 0) {
    const linkId = rng.id("L");
    const nInserts = 1 + rng.int(3);
    const inserts = [];
    for (let k = 0; k < nInserts; k++) {
      inserts.push({ op: "insert", parentId: "s1", index: rng.int(itemIds.length + 1), node: { id: rng.id("new"), type: "item", fields: { label: rng.word(), priority: "low" }, children: [] } });
    }
    return {
      name: nextName("f1-insert-relocates"),
      description: "edit-after-downlevel: known insertions around a preserved node must not disturb it",
      genesis: tree,
      steps: [
        { op: "encode", id: "e1", baseline: "genesis", version: 3, mutations: [{ op: "insert", parentId: "s1", index: anchorIdx, node: { id: linkId, type: "link", fields: { url: "http://" + rng.word() }, children: [] } }] },
        { op: "decode", id: "d1", baseline: "genesis", bytes: "e1", version: 1 },
        { op: "encode", id: "e2", baseline: "d1", version: 1, mutations: inserts },
        { op: "decode", id: "d2", baseline: "genesis", bytes: "e2", version: 3 },
      ],
      checks: [
        { kind: "nodePresent", state: "d2", nodeId: linkId },
        { kind: "immediatelyBefore", state: "d2", parentId: "s1", targetId: linkId, beforeId: anchorId },
      ],
    };
  } else {
    const linkId0 = rng.id("L0");
    const linkId1 = rng.id("L1");
    const gapItemId = rng.id("gap_new");

    const v3Mutations = [
      { op: "insert", parentId: "s1", index: anchorIdx, node: { id: linkId0, type: "link", fields: { url: "http://0" }, children: [] } },
      { op: "insert", parentId: "s1", index: anchorIdx + 1, node: { id: linkId1, type: "link", fields: { url: "http://1" }, children: [] } },
    ];
    const v1Mutations = [
      { op: "insert", parentId: "s1", index: anchorIdx, node: { id: gapItemId, type: "item", fields: { label: "gap", priority: "low" }, children: [] } },
    ];

    const expectedIds = [
      ...itemIds.slice(0, anchorIdx),
      gapItemId,
      linkId0,
      linkId1,
      ...itemIds.slice(anchorIdx),
    ];

    return {
      name: nextName("f1-insert-relocates"),
      description: "edit-after-downlevel: insertion into gap occupied by preserved content must sort before preserved content",
      genesis: tree,
      steps: [
        { op: "encode", id: "e1", baseline: "genesis", version: 3, mutations: v3Mutations },
        { op: "decode", id: "d1", baseline: "genesis", bytes: "e1", version: 1 },
        { op: "encode", id: "e2", baseline: "d1", version: 1, mutations: v1Mutations },
        { op: "decode", id: "d2", baseline: "genesis", bytes: "e2", version: 3 },
      ],
      checks: [
        { kind: "nodePresent", state: "d2", nodeId: gapItemId },
        { kind: "nodePresent", state: "d2", nodeId: linkId0 },
        { kind: "nodePresent", state: "d2", nodeId: linkId1 },
        { kind: "childOrder", state: "d2", parentId: "s1", ids: expectedIds },
        { kind: "residueEmpty", state: "d2" },
      ],
    };
  }
}

// F2: edit-after-downlevel, move across the preserved region with exact child order verification.
function genF2(rng) {
  const { tree, itemIds } = genesisWithItems(rng, 5);
  const anchorIdx = 1 + rng.int(itemIds.length - 2);
  const anchorId = itemIds[anchorIdx];
  const otherIds = itemIds.filter((id) => id !== anchorId);
  const moverId = rng.pick(otherIds);
  const moverOrigIdx = itemIds.indexOf(moverId);
  const linkId = rng.id("L");
  const estimateVal = 10 + rng.int(90);

  let newIdx = rng.int(itemIds.length);
  if (newIdx === moverOrigIdx) newIdx = (newIdx + 1) % itemIds.length;

  const v1Items = itemIds.filter((id) => id !== moverId);
  v1Items.splice(newIdx, 0, moverId);

  const finalAnchorIdx = v1Items.indexOf(anchorId);
  const expectedIds = [
    ...v1Items.slice(0, finalAnchorIdx),
    linkId,
    ...v1Items.slice(finalAnchorIdx),
  ];

  return {
    name: nextName("f2-move-across"),
    description: "edit-after-downlevel: moving an unrelated known node across the preserved region must maintain exact child order",
    genesis: tree,
    steps: [
      { op: "encode", id: "e1", baseline: "genesis", version: 3, mutations: [
        { op: "insert", parentId: "s1", index: anchorIdx, node: { id: linkId, type: "link", fields: { url: "http://x" }, children: [] } },
        { op: "setField", nodeId: anchorId, field: "estimate", value: estimateVal },
      ] },
      { op: "decode", id: "d1", baseline: "genesis", bytes: "e1", version: 1 },
      { op: "encode", id: "e2", baseline: "d1", version: 1, mutations: [{ op: "move", nodeId: moverId, newParentId: "s1", newIndex: newIdx }] },
      { op: "decode", id: "d2", baseline: "genesis", bytes: "e2", version: 3 },
    ],
    checks: [
      { kind: "nodePresent", state: "d2", nodeId: linkId },
      { kind: "fieldEquals", state: "d2", nodeId: anchorId, field: "estimate", value: estimateVal },
      { kind: "childOrder", state: "d2", parentId: "s1", ids: expectedIds },
      { kind: "residueEmpty", state: "d2" },
    ],
  };
}

// F3a: deletion of a sibling AHEAD of the preserved region.
function genF3a(rng) {
  const { tree, itemIds } = genesisWithItems(rng, 4 + rng.int(3));
  const anchorId = itemIds[itemIds.length - 1];
  const victimId = itemIds[0];
  const linkId = rng.id("L");
  return {
    name: nextName("f3a-delete-ahead"),
    description: "edit-after-downlevel: deleting a sibling ahead of the preserved region must not disturb it",
    genesis: tree,
    steps: [
      { op: "encode", id: "e1", baseline: "genesis", version: 3, mutations: [{ op: "insert", parentId: "s1", index: itemIds.indexOf(anchorId), node: { id: linkId, type: "link", fields: { url: "http://x" }, children: [] } }] },
      { op: "decode", id: "d1", baseline: "genesis", bytes: "e1", version: 1 },
      { op: "encode", id: "e2", baseline: "d1", version: 1, mutations: [{ op: "delete", nodeId: victimId }] },
      { op: "decode", id: "d2", baseline: "genesis", bytes: "e2", version: 3 },
    ],
    checks: [
      { kind: "nodePresent", state: "d2", nodeId: linkId },
      { kind: "immediatelyBefore", state: "d2", parentId: "s1", targetId: linkId, beforeId: anchorId },
    ],
  };
}

// F3b: deletion of the anchor sibling itself.
function genF3b(rng) {
  const { tree, itemIds } = genesisWithItems(rng, 5);
  const anchorIdx = 1 + rng.int(itemIds.length - 2);
  const anchorId = itemIds[anchorIdx];
  const successorId = itemIds[anchorIdx + 1];

  const style = rng.int(2);
  if (style === 0) {
    const linkId = rng.id("L");
    return {
      name: nextName("f3b-delete-anchor"),
      description: "edit-after-downlevel: deleting the exact anchor sibling must not drop the preserved node",
      genesis: tree,
      steps: [
        { op: "encode", id: "e1", baseline: "genesis", version: 3, mutations: [{ op: "insert", parentId: "s1", index: anchorIdx, node: { id: linkId, type: "link", fields: { url: "http://x" }, children: [] } }] },
        { op: "decode", id: "d1", baseline: "genesis", bytes: "e1", version: 1 },
        { op: "encode", id: "e2", baseline: "d1", version: 1, mutations: [{ op: "delete", nodeId: anchorId }] },
        { op: "decode", id: "d2", baseline: "genesis", bytes: "e2", version: 3 },
      ],
      checks: [
        { kind: "nodeAbsent", state: "d2", nodeId: anchorId },
        { kind: "nodePresent", state: "d2", nodeId: linkId },
        { kind: "immediatelyBefore", state: "d2", parentId: "s1", targetId: linkId, beforeId: successorId },
      ],
    };
  } else {
    const linkId0 = rng.id("L0");
    const linkId1 = rng.id("L1");
    const linkId2 = rng.id("L2");

    const v3Mutations = [
      { op: "insert", parentId: "s1", index: anchorIdx, node: { id: linkId0, type: "link", fields: { url: "http://0" }, children: [] } },
      { op: "insert", parentId: "s1", index: anchorIdx + 1, node: { id: linkId1, type: "link", fields: { url: "http://1" }, children: [] } },
      { op: "insert", parentId: "s1", index: anchorIdx + 2, node: { id: linkId2, type: "link", fields: { url: "http://2" }, children: [] } },
    ];

    const expectedIds = [
      ...itemIds.slice(0, anchorIdx),
      linkId0,
      linkId1,
      linkId2,
      ...itemIds.slice(anchorIdx + 1),
    ];

    return {
      name: nextName("f3b-delete-anchor"),
      description: "edit-after-downlevel: deleting the exact anchor sibling of a multi-node unknown span must preserve span ordering",
      genesis: tree,
      steps: [
        { op: "encode", id: "e1", baseline: "genesis", version: 3, mutations: v3Mutations },
        { op: "decode", id: "d1", baseline: "genesis", bytes: "e1", version: 1 },
        { op: "encode", id: "e2", baseline: "d1", version: 1, mutations: [{ op: "delete", nodeId: anchorId }] },
        { op: "decode", id: "d2", baseline: "genesis", bytes: "e2", version: 3 },
      ],
      checks: [
        { kind: "nodeAbsent", state: "d2", nodeId: anchorId },
        { kind: "nodePresent", state: "d2", nodeId: linkId0 },
        { kind: "nodePresent", state: "d2", nodeId: linkId1 },
        { kind: "nodePresent", state: "d2", nodeId: linkId2 },
        { kind: "childOrder", state: "d2", parentId: "s1", ids: expectedIds },
        { kind: "residueEmpty", state: "d2" },
      ],
    };
  }
}

// F3c: multi-anchor deletion and transitive anchor collapse.
function genF3c(rng) {
  const { tree, itemIds } = genesisWithItems(rng, 6);
  const a = itemIds[1];
  const b = itemIds[2];
  const c = itemIds[3];
  const linkId0 = rng.id("L0");
  const linkId1 = rng.id("L1");

  const v3Mutations = [
    { op: "insert", parentId: "s1", index: 2, node: { id: linkId0, type: "link", fields: { url: "http://0" }, children: [] } },
    { op: "insert", parentId: "s1", index: 3, node: { id: linkId1, type: "link", fields: { url: "http://1" }, children: [] } },
  ];

  // Downlevel peer deletes both surrounding anchors b and c
  const v1Mutations = [
    { op: "delete", nodeId: b },
    { op: "delete", nodeId: c },
  ];

  const expectedIds = [itemIds[0], a, linkId0, linkId1, itemIds[4], itemIds[5]];

  return {
    name: nextName("f3c-multi-anchor-collapse"),
    description: "edit-after-downlevel: deleting consecutive anchor siblings must transitively re-anchor preserved span without ordering loss",
    genesis: tree,
    steps: [
      { op: "encode", id: "e1", baseline: "genesis", version: 3, mutations: v3Mutations },
      { op: "decode", id: "d1", baseline: "genesis", bytes: "e1", version: 1 },
      { op: "encode", id: "e2", baseline: "d1", version: 1, mutations: v1Mutations },
      { op: "decode", id: "d2", baseline: "genesis", bytes: "e2", version: 3 },
    ],
    checks: [
      { kind: "nodeAbsent", state: "d2", nodeId: b },
      { kind: "nodeAbsent", state: "d2", nodeId: c },
      { kind: "nodePresent", state: "d2", nodeId: linkId0 },
      { kind: "nodePresent", state: "d2", nodeId: linkId1 },
      { kind: "childOrder", state: "d2", parentId: "s1", ids: expectedIds },
      { kind: "residueEmpty", state: "d2" },
    ],
  };
}

// F4: deletion of a node whose descendants carry higher-version content (non-resurrection).
function genF4(rng) {
  const { tree, itemIds } = genesisWithItems(rng, 3 + rng.int(3));
  const victimId = rng.pick(itemIds);
  const linkId = rng.id("L");
  const estimateVal = rng.int(100);
  return {
    name: nextName("f4-delete-with-descendant-content"),
    description: "deleting a node whose descendants carry higher-version content must leave nothing behind",
    genesis: tree,
    steps: [
      { op: "encode", id: "e1", baseline: "genesis", version: 3, mutations: [
        { op: "insert", parentId: victimId, index: 0, node: { id: linkId, type: "link", fields: { url: "http://x" }, children: [] } },
        { op: "setField", nodeId: victimId, field: "estimate", value: estimateVal },
      ] },
      { op: "decode", id: "d1", baseline: "genesis", bytes: "e1", version: 1 },
      { op: "encode", id: "e2", baseline: "d1", version: 1, mutations: [{ op: "delete", nodeId: victimId }] },
      { op: "decode", id: "d2", baseline: "genesis", bytes: "e2", version: 3 },
    ],
    checks: [
      { kind: "nodeAbsent", state: "d2", nodeId: victimId },
      { kind: "nodeAbsent", state: "d2", nodeId: linkId },
      { kind: "residueEmpty", state: "d2" },
    ],
  };
}

// F5: move of a known node carrying unknown content across a subtree boundary.
function genF5(rng) {
  const { tree, itemIds } = genesisWithItems(rng, 4);
  const moverId = itemIds[1];
  const linkId = rng.id("L");
  const estimateVal = 10 + rng.int(90);

  const remainingS1 = itemIds.filter((id) => id !== moverId);

  return {
    name: nextName("f5-move-unknown-bearing-across-boundary"),
    description: "moving a node carrying unknown content to a different parent must preserve its full subtree and parentage",
    genesis: tree,
    steps: [
      { op: "encode", id: "e1", baseline: "genesis", version: 3, mutations: [
        { op: "insert", parentId: moverId, index: 0, node: { id: linkId, type: "link", fields: { url: "http://x" }, children: [] } },
        { op: "setField", nodeId: moverId, field: "estimate", value: estimateVal },
      ] },
      { op: "decode", id: "d1", baseline: "genesis", bytes: "e1", version: 1 },
      { op: "encode", id: "e2", baseline: "d1", version: 1, mutations: [{ op: "move", nodeId: moverId, newParentId: "root", newIndex: 0 }] },
      { op: "decode", id: "d2", baseline: "genesis", bytes: "e2", version: 3 },
    ],
    checks: [
      { kind: "fieldEquals", state: "d2", nodeId: moverId, field: "estimate", value: estimateVal },
      { kind: "nodePresent", state: "d2", nodeId: linkId },
      { kind: "childOrder", state: "d2", parentId: moverId, ids: [linkId] },
      { kind: "childOrder", state: "d2", parentId: "s1", ids: remainingS1 },
      { kind: "childOrder", state: "d2", parentId: "root", ids: [moverId, "s1"] },
      { kind: "residueEmpty", state: "d2" },
    ],
  };
}

// F6: 3-, 4-, 5-, or 6-hop chains with concurrent edits, structural moves, and asymmetric enum fields.
function genF6(rng, hops) {
  const { tree, itemIds } = genesisWithItems(rng, 4 + rng.int(2));
  const a = itemIds[0];
  const b = itemIds[1];
  const c = itemIds[2];
  const linkId = rng.id("L");
  const v3Val = rng.word();
  const v1Val = rng.word();
  const v2Val = rng.word();
  const v2Val2 = rng.word();
  const v1Val2 = rng.word();
  const v3Estimate = 10 + rng.int(90);

  const e1Mutations = [
    { op: "insert", parentId: "s1", index: 1, node: { id: linkId, type: "link", fields: { url: "http://x" }, children: [] } },
    { op: "setField", nodeId: a, field: "label", value: v3Val },
  ];
  if (hops >= 4) {
    e1Mutations.push({ op: "setField", nodeId: a, field: "estimate", value: v3Estimate });
    e1Mutations.push({ op: "setField", nodeId: a, field: "priority", value: "urgent" });
  }

  const e2Mutations = [
    { op: "setField", nodeId: a, field: "label", value: v3Val },
    { op: "setField", nodeId: b, field: "label", value: v1Val },
  ];
  if (hops >= 4) {
    e2Mutations.unshift({ op: "move", nodeId: c, newParentId: "s1", newIndex: 0 });
  }

  const steps = [
    { op: "encode", id: "e1", baseline: "genesis", version: 3, mutations: e1Mutations },
    { op: "decode", id: "d1", baseline: "genesis", bytes: "e1", version: 1 },
    { op: "encode", id: "e2", baseline: "d1", version: 1, mutations: e2Mutations },
    { op: "decode", id: "d2", baseline: "genesis", bytes: "e2", version: 2 },
  ];

  let finalState = "d2";
  if (hops >= 4) {
    const e3Mutations = [
      { op: "move", nodeId: c, newParentId: "s1", newIndex: 0 },
      { op: "setField", nodeId: a, field: "label", value: v3Val },
      { op: "setField", nodeId: b, field: "label", value: v1Val },
      { op: "setField", nodeId: b, field: "dueDate", value: v2Val },
    ];
    steps.push(
      { op: "encode", id: "e3", baseline: "d2", version: 2, mutations: e3Mutations },
      { op: "decode", id: "d3", baseline: "genesis", bytes: "e3", version: hops === 4 ? 3 : 1 }
    );
    finalState = "d3";
  }

  if (hops >= 5) {
    const e4Mutations = [
      { op: "move", nodeId: c, newParentId: "s1", newIndex: 0 },
      { op: "setField", nodeId: a, field: "label", value: v1Val2 },
      { op: "setField", nodeId: b, field: "label", value: v1Val },
    ];
    steps.push(
      { op: "encode", id: "e4", baseline: "d3", version: 1, mutations: e4Mutations },
      { op: "decode", id: "d4", baseline: "genesis", bytes: "e4", version: hops === 5 ? 3 : 2 }
    );
    finalState = "d4";
  }

  if (hops === 6) {
    const e5Mutations = [
      { op: "move", nodeId: c, newParentId: "s1", newIndex: 0 },
      { op: "setField", nodeId: a, field: "label", value: v1Val2 },
      { op: "setField", nodeId: b, field: "label", value: v1Val },
      { op: "setField", nodeId: b, field: "dueDate", value: v2Val },
      { op: "setField", nodeId: a, field: "dueDate", value: v2Val2 },
    ];
    steps.push(
      { op: "encode", id: "e5", baseline: "d4", version: 2, mutations: e5Mutations },
      { op: "decode", id: "d5", baseline: "genesis", bytes: "e5", version: 3 }
    );
    finalState = "d5";
  }

  const checks = [
    { kind: "fieldEquals", state: finalState, nodeId: a, field: "label", value: hops >= 5 ? v1Val2 : v3Val },
    { kind: "fieldEquals", state: finalState, nodeId: b, field: "label", value: v1Val },
  ];

  if (hops >= 4) {
    checks.push({ kind: "fieldEquals", state: finalState, nodeId: b, field: "dueDate", value: v2Val });
    checks.push({ kind: "fieldEquals", state: finalState, nodeId: a, field: "estimate", value: v3Estimate });
    checks.push({ kind: "fieldEquals", state: finalState, nodeId: a, field: "priority", value: "urgent" });

    const rest = itemIds.slice(3);
    const expectedIds = [c, a, linkId, b, ...rest];
    if (hops === 4 || hops === 6) {
      checks.push({ kind: "childOrder", state: finalState, parentId: "s1", ids: expectedIds });
      checks.push({ kind: "residueEmpty", state: finalState });
    }
  }
  if (hops === 6) checks.push({ kind: "fieldEquals", state: finalState, nodeId: a, field: "dueDate", value: v2Val2 });

  if (hops === 4 || hops === 5 || hops === 6) {
    checks.push({ kind: "nodePresent", state: finalState, nodeId: linkId });
  } else {
    checks.push({ kind: "roundTripNodePresent", state: finalState, reencodeVersion: 2, decodeVersion: 3, nodeId: linkId });
  }

  return {
    name: nextName(`f6-${hops}hop-concurrent`),
    description: `${hops}-hop chain with concurrent structural moves, enum widening, and asymmetric schema fields`,
    genesis: tree,
    steps,
    checks,
  };
}

// F7: deltas sized close to the bound.
function genF7(rng) {
  const { tree, itemIds } = genesisWithItems(rng, 3 + rng.int(3));
  const targetId = rng.pick(itemIds);
  const len = 4 + rng.int(40);
  const value = Array.from({ length: len }, () => rng.pick(["a", "b", "c", "d", "e"])).join("");
  return {
    name: nextName("f7-bound-tight"),
    description: "a single field edit whose payload size varies, exercised close to the tight size bound",
    genesis: tree,
    steps: [{ op: "encode", id: "e1", baseline: "genesis", version: 1, mutations: [{ op: "setField", nodeId: targetId, field: "label", value }] }],
    checks: [{ kind: "sizeBound", bytes: "e1" }],
  };
}

// F8: sibling permutations around preserved nodes (diverse styles defeating single-anchor heuristics).
function genF8(rng) {
  const { tree, itemIds } = genesisWithItems(rng, 5);
  const a = itemIds[1];
  const b = itemIds[2];
  const uId0 = rng.id("L0");
  const uId1 = rng.id("L1");
  const unknownIds = [uId0, uId1];
  const unknownNodes = [
    { op: "insert", parentId: "s1", index: 2, node: { id: uId0, type: "link", fields: { url: "http://" + rng.word() }, children: [] } },
    { op: "insert", parentId: "s1", index: 3, node: { id: uId1, type: "link", fields: { url: "http://" + rng.word() }, children: [] } },
  ];

  const style = rng.int(5);
  let v1Mutations, expectedIds;
  if (style === 0) {
    v1Mutations = [{ op: "move", nodeId: itemIds[0], newParentId: "s1", newIndex: 2 }];
    expectedIds = [a, ...unknownIds, b, itemIds[0], itemIds[3], itemIds[4]];
  } else if (style === 1) {
    v1Mutations = [{ op: "move", nodeId: itemIds[3], newParentId: "s1", newIndex: 1 }];
    expectedIds = [itemIds[0], itemIds[3], a, ...unknownIds, b, itemIds[4]];
  } else if (style === 2) {
    const newId = rng.id("v1new");
    v1Mutations = [{ op: "insert", parentId: "s1", index: 2, node: { id: newId, type: "item", fields: { label: "gap_item", priority: "low" }, children: [] } }];
    expectedIds = [itemIds[0], a, newId, ...unknownIds, b, itemIds[3], itemIds[4]];
  } else if (style === 3) {
    const uId2 = rng.id("L2");
    const uId3 = rng.id("L3");
    unknownIds.push(uId2, uId3);
    unknownNodes.push(
      { op: "insert", parentId: "s1", index: 5, node: { id: uId2, type: "link", fields: { url: "http://" + rng.word() }, children: [] } },
      { op: "insert", parentId: "s1", index: 6, node: { id: uId3, type: "link", fields: { url: "http://" + rng.word() }, children: [] } },
    );
    v1Mutations = [{ op: "move", nodeId: itemIds[4], newParentId: "s1", newIndex: 0 }];
    expectedIds = [itemIds[4], itemIds[0], a, uId0, uId1, b, uId2, uId3, itemIds[3]];
  } else {
    v1Mutations = [{ op: "move", nodeId: a, newParentId: "s1", newIndex: 4 }];
    expectedIds = [itemIds[0], ...unknownIds, b, itemIds[3], itemIds[4], a];
  }

  const checks = [
    { kind: "childOrder", state: "d2", parentId: "s1", ids: expectedIds },
    { kind: "residueEmpty", state: "d2" },
  ];
  for (const uId of unknownIds) {
    checks.push({ kind: "nodePresent", state: "d2", nodeId: uId });
  }

  return {
    name: nextName("f8-permute-siblings"),
    description: "edit-after-downlevel: complex sibling permutations and gap insertions must preserve relative ordering",
    genesis: tree,
    steps: [
      { op: "encode", id: "e1", baseline: "genesis", version: 3, mutations: unknownNodes },
      { op: "decode", id: "d1", baseline: "genesis", bytes: "e1", version: 1 },
      { op: "encode", id: "e2", baseline: "d1", version: 1, mutations: v1Mutations },
      { op: "decode", id: "d2", baseline: "genesis", bytes: "e2", version: 3 },
    ],
    checks,
  };
}

// F9: mutation stream compaction under extreme churn (transient subtrees, repeated overwrites, circular moves).
function genF9(rng) {
  const tree = {
    id: "root", type: "root", fields: {},
    children: [
      {
        id: "s1", type: "section", fields: { title: "sec1", status: "open" },
        children: [
          { id: "i1", type: "item", fields: { label: "item1", priority: "low" }, children: [] },
          { id: "i2", type: "item", fields: { label: "item2", priority: "low" }, children: [] },
        ]
      },
      {
        id: "s2", type: "section", fields: { title: "sec2", status: "open" },
        children: []
      }
    ]
  };

  const targetId = "i1";
  const moverId = "i2";
  const tempP1 = rng.id("tempP1");
  const tempC1 = rng.id("tempC1");
  const tempP2 = rng.id("tempP2");
  const tempC2 = rng.id("tempC2");
  const tempP3 = rng.id("tempP3");
  const tempC3 = rng.id("tempC3");
  const finalVal = "final_" + rng.word();
  const finalPriority = rng.pick(["low", "med", "high"]);

  const mutations = [
    { op: "move", nodeId: moverId, newParentId: "s2", newIndex: 0 },
    { op: "setField", nodeId: targetId, field: "label", value: "c1_" + rng.word() },
    { op: "setField", nodeId: targetId, field: "label", value: "c2_" + rng.word() },
    { op: "move", nodeId: moverId, newParentId: "s1", newIndex: 1 },
    { op: "insert", parentId: "s1", index: 0, node: { id: tempP1, type: "item", fields: { label: "temp1", priority: "low" }, children: [] } },
    { op: "insert", parentId: tempP1, index: 0, node: { id: tempC1, type: "note", fields: { text: "note1" }, children: [] } },
    { op: "setField", nodeId: tempC1, field: "text", value: "note1_edited" },
    { op: "setField", nodeId: tempP1, field: "label", value: "temp1_edited" },
    { op: "delete", nodeId: tempP1 },
    { op: "setField", nodeId: targetId, field: "priority", value: "med" },
    { op: "setField", nodeId: targetId, field: "priority", value: "high" },
    { op: "setField", nodeId: targetId, field: "label", value: "c3_" + rng.word() },
    { op: "move", nodeId: moverId, newParentId: "s2", newIndex: 0 },
    { op: "insert", parentId: "s2", index: 1, node: { id: tempP2, type: "item", fields: { label: "temp2", priority: "low" }, children: [] } },
    { op: "insert", parentId: tempP2, index: 0, node: { id: tempC2, type: "note", fields: { text: "note2" }, children: [] } },
    { op: "delete", nodeId: tempP2 },
    { op: "move", nodeId: moverId, newParentId: "s1", newIndex: 0 },
    { op: "insert", parentId: "s1", index: 0, node: { id: tempP3, type: "item", fields: { label: "temp3", priority: "low" }, children: [
      { id: tempC3, type: "note", fields: { text: "note3" }, children: [] }
    ] } },
    { op: "delete", nodeId: tempP3 },
    { op: "setField", nodeId: targetId, field: "label", value: "c4_" + rng.word() },
    { op: "setField", nodeId: targetId, field: "label", value: finalVal },
    { op: "setField", nodeId: targetId, field: "priority", value: finalPriority },
    { op: "move", nodeId: moverId, newParentId: "s2", newIndex: 0 },
  ];

  return {
    name: nextName("f9-compaction-churn"),
    description: "authored delta with heavy multi-subtree churn, rapid overwrites, transient inserts, and transitive moves",
    genesis: tree,
    steps: [
      { op: "encode", id: "e1", baseline: "genesis", version: 1, mutations },
      { op: "decode", id: "d1", baseline: "genesis", bytes: "e1", version: 1 },
    ],
    checks: [
      { kind: "fieldEquals", state: "d1", nodeId: targetId, field: "label", value: finalVal },
      { kind: "fieldEquals", state: "d1", nodeId: targetId, field: "priority", value: finalPriority },
      { kind: "nodeAbsent", state: "d1", nodeId: tempP1 },
      { kind: "nodeAbsent", state: "d1", nodeId: tempC1 },
      { kind: "nodeAbsent", state: "d1", nodeId: tempP2 },
      { kind: "nodeAbsent", state: "d1", nodeId: tempC2 },
      { kind: "nodeAbsent", state: "d1", nodeId: tempP3 },
      { kind: "nodeAbsent", state: "d1", nodeId: tempC3 },
      { kind: "childOrder", state: "d1", parentId: "s2", ids: [moverId] },
      { kind: "sizeBound", bytes: "e1" },
    ],
  };
}

// F10: nested subtree preservation (4-tier hierarchy with mixed known/unknown descendants).
function genF10(rng) {
  const tree = {
    id: "root", type: "root", fields: {},
    children: [
      {
        id: "s1", type: "section", fields: { title: "sec1", status: "open" },
        children: [
          { id: "p1", type: "item", fields: { label: "parent1", priority: "low" }, children: [] },
          { id: "p2", type: "item", fields: { label: "parent2", priority: "low" }, children: [] },
        ]
      },
      {
        id: "s2", type: "section", fields: { title: "sec2", status: "open" },
        children: []
      }
    ]
  };

  const linkId = rng.id("L");
  const tag1 = rng.id("tag1");
  const tag2 = rng.id("tag2");
  const item1 = rng.id("item1");
  const item2 = rng.id("item2");
  const note1 = rng.id("note1");
  const note2 = rng.id("note2");
  const tagName1 = "tag_" + rng.word();
  const tagName2 = "tag_" + rng.word();
  const noteText1 = "note_" + rng.word();
  const noteText2 = "note_" + rng.word();

  const deepTree = {
    id: linkId, type: "link", fields: { url: "http://deep" },
    children: [
      {
        id: tag1, type: "tag", fields: { name: tagName1 },
        children: [
          { id: item1, type: "item", fields: { label: "subitem1", priority: "urgent", estimate: 50 },
            children: [
              { id: note1, type: "note", fields: { text: noteText1 }, children: [] }
            ]
          }
        ]
      },
      {
        id: tag2, type: "tag", fields: { name: tagName2 },
        children: [
          { id: item2, type: "item", fields: { label: "subitem2", priority: "urgent", estimate: 75 },
            children: [
              { id: note2, type: "note", fields: { text: noteText2 }, children: [] }
            ]
          }
        ]
      }
    ]
  };

  const style = rng.int(3);
  let v1Mutations, checks;
  if (style === 0) {
    const newId = rng.id("fresh");
    v1Mutations = [
      { op: "move", nodeId: "p1", newParentId: "s2", newIndex: 0 },
      { op: "insert", parentId: "s2", index: 0, node: { id: newId, type: "item", fields: { label: "front", priority: "low" }, children: [] } },
      { op: "delete", nodeId: "p2" },
    ];
    checks = [
      { kind: "nodePresent", state: "d2", nodeId: newId },
      { kind: "nodeAbsent", state: "d2", nodeId: "p2" },
      { kind: "childOrder", state: "d2", parentId: "s2", ids: [newId, "p1"] },
      { kind: "childOrder", state: "d2", parentId: "p1", ids: [linkId] },
      { kind: "childOrder", state: "d2", parentId: linkId, ids: [tag1, tag2] },
      { kind: "childOrder", state: "d2", parentId: tag1, ids: [item1] },
      { kind: "childOrder", state: "d2", parentId: tag2, ids: [item2] },
      { kind: "childOrder", state: "d2", parentId: item1, ids: [note1] },
      { kind: "childOrder", state: "d2", parentId: item2, ids: [note2] },
      { kind: "fieldEquals", state: "d2", nodeId: tag1, field: "name", value: tagName1 },
      { kind: "fieldEquals", state: "d2", nodeId: tag2, field: "name", value: tagName2 },
      { kind: "fieldEquals", state: "d2", nodeId: note1, field: "text", value: noteText1 },
      { kind: "fieldEquals", state: "d2", nodeId: note2, field: "text", value: noteText2 },
      { kind: "residueEmpty", state: "d2" },
    ];
  } else if (style === 1) {
    v1Mutations = [{ op: "delete", nodeId: "p1" }];
    checks = [
      { kind: "nodeAbsent", state: "d2", nodeId: "p1" },
      { kind: "nodeAbsent", state: "d2", nodeId: linkId },
      { kind: "nodeAbsent", state: "d2", nodeId: tag1 },
      { kind: "nodeAbsent", state: "d2", nodeId: tag2 },
      { kind: "nodeAbsent", state: "d2", nodeId: item1 },
      { kind: "nodeAbsent", state: "d2", nodeId: item2 },
      { kind: "nodeAbsent", state: "d2", nodeId: note1 },
      { kind: "nodeAbsent", state: "d2", nodeId: note2 },
      { kind: "residueEmpty", state: "d2" },
    ];
  } else {
    const newId = rng.id("sib");
    v1Mutations = [
      { op: "insert", parentId: "s1", index: 0, node: { id: newId, type: "item", fields: { label: "sib", priority: "low" }, children: [] } },
      { op: "setField", nodeId: "p1", field: "label", value: "p1_edited" },
    ];
    checks = [
      { kind: "nodePresent", state: "d2", nodeId: newId },
      { kind: "fieldEquals", state: "d2", nodeId: "p1", field: "label", value: "p1_edited" },
      { kind: "childOrder", state: "d2", parentId: linkId, ids: [tag1, tag2] },
      { kind: "childOrder", state: "d2", parentId: tag1, ids: [item1] },
      { kind: "childOrder", state: "d2", parentId: tag2, ids: [item2] },
      { kind: "residueEmpty", state: "d2" },
    ];
  }

  return {
    name: nextName("f10-nested-subtree"),
    description: "multi-tier nested unknown subtree must survive parent moves, cascading deletes, and sibling additions",
    genesis: tree,
    steps: [
      { op: "encode", id: "e1", baseline: "genesis", version: 3, mutations: [{ op: "insert", parentId: style === 2 ? "s1" : "p1", index: style === 2 ? 1 : 0, node: deepTree }] },
      { op: "decode", id: "d1", baseline: "genesis", bytes: "e1", version: 1 },
      { op: "encode", id: "e2", baseline: "d1", version: 1, mutations: v1Mutations },
      { op: "decode", id: "d2", baseline: "genesis", bytes: "e2", version: 3 },
    ],
    checks,
  };
}

// F11: widened enum preservation across intermediate downlevel edits.
function genF11(rng) {
  const { tree, itemIds } = genesisWithItems(rng, 4);
  const targetId = itemIds[0];
  const otherId = itemIds[1];
  const newLabel = "label_" + rng.word();
  const newDueDate = "date_" + rng.word();

  return {
    name: nextName("f11-widened-enum-transit"),
    description: "widened enum value must survive intermediate downlevel edits and materialize upon uplevel decode",
    genesis: tree,
    steps: [
      { op: "encode", id: "e1", baseline: "genesis", version: 3, mutations: [
        { op: "setField", nodeId: targetId, field: "priority", value: "urgent" },
        { op: "setField", nodeId: otherId, field: "label", value: newLabel },
      ] },
      { op: "decode", id: "d1", baseline: "genesis", bytes: "e1", version: 1 },
      { op: "encode", id: "e2", baseline: "d1", version: 1, mutations: [
        { op: "setField", nodeId: otherId, field: "priority", value: "high" },
      ] },
      { op: "decode", id: "d2", baseline: "genesis", bytes: "e2", version: 2 },
      { op: "encode", id: "e3", baseline: "d2", version: 2, mutations: [
        { op: "setField", nodeId: targetId, field: "dueDate", value: newDueDate },
        { op: "setField", nodeId: otherId, field: "priority", value: "high" },
      ] },
      { op: "decode", id: "d3", baseline: "genesis", bytes: "e3", version: 3 },
    ],
    checks: [
      { kind: "fieldEquals", state: "d3", nodeId: targetId, field: "priority", value: "urgent" },
      { kind: "fieldEquals", state: "d3", nodeId: targetId, field: "dueDate", value: newDueDate },
      { kind: "fieldEquals", state: "d3", nodeId: otherId, field: "priority", value: "high" },
      { kind: "residueEmpty", state: "d3" },
    ],
  };
}

// F12: transitive unknown-to-unknown anchor chains and complex reversals.
function genF12(rng) {
  const { tree, itemIds } = genesisWithItems(rng, 4);
  const k0 = itemIds[0];
  const k1 = itemIds[1];
  const k2 = itemIds[2];
  const k3 = itemIds[3];

  const u0 = rng.id("U0");
  const u1 = rng.id("U1");
  const u2 = rng.id("U2");
  const u3 = rng.id("U3");

  const v3Mutations = [
    { op: "insert", parentId: "s1", index: 1, node: { id: u0, type: "link", fields: { url: "http://0" }, children: [] } },
    { op: "insert", parentId: "s1", index: 2, node: { id: u1, type: "link", fields: { url: "http://1" }, children: [] } },
    { op: "insert", parentId: "s1", index: 4, node: { id: u2, type: "link", fields: { url: "http://2" }, children: [] } },
    { op: "insert", parentId: "s1", index: 5, node: { id: u3, type: "link", fields: { url: "http://3" }, children: [] } },
  ];

  // Downlevel peer moves k3 to front and moves k0 to end
  const v1Mutations = [
    { op: "move", nodeId: k3, newParentId: "s1", newIndex: 0 },
    { op: "move", nodeId: k0, newParentId: "s1", newIndex: 3 },
  ];

  const expectedIds = [k3, u0, u1, k1, u2, u3, k2, k0];

  return {
    name: nextName("f12-transitive-anchor-reorder"),
    description: "transitive unknown-to-unknown anchor chains must maintain strict relative ordering across non-local sibling relocations",
    genesis: tree,
    steps: [
      { op: "encode", id: "e1", baseline: "genesis", version: 3, mutations: v3Mutations },
      { op: "decode", id: "d1", baseline: "genesis", bytes: "e1", version: 1 },
      { op: "encode", id: "e2", baseline: "d1", version: 1, mutations: v1Mutations },
      { op: "decode", id: "d2", baseline: "genesis", bytes: "e2", version: 3 },
    ],
    checks: [
      { kind: "nodePresent", state: "d2", nodeId: u0 },
      { kind: "nodePresent", state: "d2", nodeId: u1 },
      { kind: "nodePresent", state: "d2", nodeId: u2 },
      { kind: "nodePresent", state: "d2", nodeId: u3 },
      { kind: "childOrder", state: "d2", parentId: "s1", ids: expectedIds },
      { kind: "residueEmpty", state: "d2" },
    ],
  };
}

export function generateHeldOut(seed) {
  const rng = makeRng(seed);
  counter = 0;
  const scenarios = [];
  const counts = {
    f1: 40,
    f2: 35,
    f3a: 20,
    f3b: 20,
    f3c: 20,
    f4: 25,
    f5: 25,
    f6_3: 15,
    f6_4: 15,
    f6_5: 15,
    f6_6: 15,
    f7: 25,
    f8: 25,
    f9: 25,
    f10: 15,
    f11: 20,
    f12: 20,
  };
  for (let i = 0; i < counts.f1; i++) scenarios.push(genF1(rng));
  for (let i = 0; i < counts.f2; i++) scenarios.push(genF2(rng));
  for (let i = 0; i < counts.f3a; i++) scenarios.push(genF3a(rng));
  for (let i = 0; i < counts.f3b; i++) scenarios.push(genF3b(rng));
  for (let i = 0; i < counts.f3c; i++) scenarios.push(genF3c(rng));
  for (let i = 0; i < counts.f4; i++) scenarios.push(genF4(rng));
  for (let i = 0; i < counts.f5; i++) scenarios.push(genF5(rng));
  for (let i = 0; i < counts.f6_3; i++) scenarios.push(genF6(rng, 3));
  for (let i = 0; i < counts.f6_4; i++) scenarios.push(genF6(rng, 4));
  for (let i = 0; i < counts.f6_5; i++) scenarios.push(genF6(rng, 5));
  for (let i = 0; i < counts.f6_6; i++) scenarios.push(genF6(rng, 6));
  for (let i = 0; i < counts.f7; i++) scenarios.push(genF7(rng));
  for (let i = 0; i < counts.f8; i++) scenarios.push(genF8(rng));
  for (let i = 0; i < counts.f9; i++) scenarios.push(genF9(rng));
  for (let i = 0; i < counts.f10; i++) scenarios.push(genF10(rng));
  for (let i = 0; i < counts.f11; i++) scenarios.push(genF11(rng));
  for (let i = 0; i < counts.f12; i++) scenarios.push(genF12(rng));
  return { scenarios, counts, total: scenarios.length };
}
