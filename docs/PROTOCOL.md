# PROTOCOL

This is the normative contract for the codec at `src/index.js`. Every rule below
is verified by the test suite. Nothing else about the wire representation is
constrained: byte layout, field ordering, and the shape of `residue` are
entirely the codec's own design.

## Node model

A tree node is `{ id, type, fields, children }`. `id` is a stable string,
assigned once and never reused or reassigned. `type` names a node type drawn
from some schema version. `fields` is a map of field name to value. `children`
is an ordered array of child nodes; order is meaningful and part of the state.

## Mutations

A mutation is one of:

- `{ op: "insert", parentId, index, node }` — inserts `node` (with its full
  subtree) as a child of `parentId` at position `index`.
- `{ op: "delete", nodeId }` — removes the node identified by `nodeId`,
  together with its entire subtree, from its parent's children.
- `{ op: "move", nodeId, newParentId, newIndex }` — relocates the node
  identified by `nodeId`, together with its entire subtree, to be a child of
  `newParentId` at position `newIndex`. The node's own id, type, fields, and
  children are unchanged by a move.
- `{ op: "setField", nodeId, field, value }` — sets `field` on the node
  identified by `nodeId` to `value`, overwriting any prior value for that
  field on that node. It does not affect any other field or any other node.

Mutations are given as an ordered list and are meant to be applied in that
order.

## Schema evolution

Three schema versions exist: v1, v2, v3. Each later version is produced from
the one before it using only these operations:

1. adding a new node type,
2. adding an optional field to an existing node type,
3. widening an enum-valued field with new allowed members.

No version ever removes a node type or field, retypes a field, reorders
anything, or adds a required field. A schema version therefore never makes an
earlier version's node types, fields, or enum members invalid — it only adds
to what is legal.

## Codec interface

`src/index.js` exports exactly:

```
export function encode(baseline, mutations, version) -> Uint8Array
export function decode(baseline, bytes, version) -> { tree, residue }
```

`baseline` is `{ tree, residue }`: `tree` is the shared tree state, `residue`
is an opaque value the caller has no visibility into. `mutations` is the
ordered mutation list, authored at `version`, to be conveyed. `version` is
the schema version of the peer performing the operation (encoding or
decoding). `decode` returns the resulting tree, plus an opaque `residue`
value that the caller passes back as part of `baseline` on a later `encode`
or `decode` call for the same line of communication. The content and
structure of `residue` are not specified — not its shape, not whether it is
even object-shaped at all — callers must treat it as opaque and must not
assume, construct, or validate any particular form for it.

The very first call in any line of communication — before either side has
ever decoded anything — has `baseline.residue` set to `null`: there is
nothing yet for any prior `decode()` to have produced. A conforming codec
must treat `null` (nothing preserved) as the residue state for this call,
regardless of what shape it otherwise gives `residue` once one exists.
`baseline.tree` for this first call is the tree state agreed out of band
(for example, an initially empty or seed tree both sides start from).

If `bytes` is malformed (not valid wire data produced by a conforming `encode()` call),
or a mutation in the list given to `encode()` is not well-formed against `baseline`
(for example, it names a `parentId` or `nodeId` that does not exist, attempts to move or delete
the root node, attempts to insert a duplicate node ID already in the tree, specifies an out-of-bounds
child index, or attempts a move that would create a directed cycle by placing a node into its own descendant),
the call must throw an Error rather than return a silently corrupted result. In multi-hop chains, deltas
carry forward preserved extensions and may be decoded against a prior baseline (such as genesis);
`decode()` applies all conveyed content and residue without requiring identical baseline instance identity.

Each `decode()` call must be fully correct given only its own `baseline` and
`bytes` arguments. Do not assume the decoding side has received, or will
ever receive, any other `encode()` output beyond what its stated `baseline`
already reflects — a call has no way to know who else may decode the same
bytes, or what they already hold beyond `baseline` itself.

## Downlevel decode: a peer receives a delta from a later schema version

When a peer at version N decodes a delta authored at version M > N:

- Every mutation the peer's schema understands must be applied exactly as
  described above.
- Every part of the delta the peer's schema does not understand — an unknown
  node type, an unknown field on an otherwise-known node type, or an unknown
  member of an otherwise-known enum-valued field — must be preserved rather
  than dropped, even though the peer cannot interpret it. "Preserved" means
  carried in the codec's own opaque residue, not materialized into the typed
  `tree` result: an unknown node type does not appear as a node in `tree`,
  an unknown field does not appear in its known node's `fields`, and a
  `setField` to an unknown enum member leaves that node's field at whatever
  known value it already held (or absent, if it was never set at a value
  this peer understands) rather than taking the new value.
- If that peer subsequently edits the resulting tree (using only mutations
  legal at its own version) and encodes a new delta, every part it preserved
  must reappear, unchanged, when a peer that does understand it later decodes
  that new delta — correctly positioned relative to siblings that peer inserted,
  deleted, or moved, exactly as if a peer who understood the preserved
  content had made the same edits around it. This holds regardless of how
  many edits the preserving peer makes around the preserved content before
  forwarding it onward.
- Preserved content maintains stable relative placement among visible siblings:
  when multiple preserved nodes exist within a sibling span, their relative ordering
  with respect to each other and surrounding visible siblings must be strictly preserved
  across downlevel insertions, deletions, movements, and sibling permutations/reversals.
  When multiple anchor siblings around preserved nodes are deleted in sequence, anchor
  resolution must fall back transitively to surviving boundary siblings.
  Any newly authored insertion made by a preserving peer into a gap occupied by preserved
  content must sort before that preserved content once a peer that understands both decodes
  the result.
- Deep nested subtree structural preservation: if an unknown node contains descendants
  (regardless of nesting depth, including combinations of known and unknown descendant types),
  downlevel peers that do not recognize that node type must omit the unknown node and its
  entire descendant subtree from the typed tree. Any mutations authored by the downlevel peer
  to other parts of the tree must not drop, displace, or alter the hierarchy or relative
  order of the preserved subtree upon uplevel decode.

## Uplevel decode: a peer receives a delta from an earlier schema version

When a peer at version M decodes a delta authored at version N < M:

- If the delta deletes a node, nothing that was ever attached to that node —
  including fields or child content that only exist at versions later than
  N — may reappear afterward. Deletion by an earlier-version peer is final
  for everything under that node, even content that peer never knew existed (non-resurrection).
- If the delta moves a node, everything attached to that node (including unknown
  fields and descendant subtrees) moves with it.
- A part of the tree that a delta's author neither touched nor understood
  must appear unchanged to a peer decoding that delta, regardless of that
  peer's own version.

## Multi-hop transit

A delta may pass through a chain of peers at different versions before reaching its
destination — for example, a v3 peer edits, a v1 peer receives that delta, applies what it
understands, edits further, and forwards its own delta to a v2 peer. Intermediate peers
with partial schema understanding (such as a v2 peer recognizing tags but not links) must
correctly materialize the subset of nodes and fields they understand into their typed tree,
apply their own edits, and re-encode such that both newly authored edits and continued
residue (unrecognized types) are successfully forwarded to subsequent peers. Chains of up
to six peers (such as v3 -> v1 -> v2 -> v1 -> v3) must recover all original extensions
and intermediate modifications intact, with exact structural positioning.

## Size bound

For a delta `encode()` produces from a baseline whose residue is empty -
nothing preserved from an earlier decode that still needs to be carried
forward - given the mutation list that produced it:

$$
\text{bytes} \le 2.4 \times (\text{net content bytes}) + 48 \times (\text{net touched node count}) + 128
$$

"Net content bytes" is the serialized size of the payload in the canonically
compacted mutation set (coalescing redundant field overwrites, transient
insertions destroyed within the same batch, and intermediate moves to their net
effect). "Net touched node count" is the number of distinct node ids touched by
the canonically compacted mutation set. This bound applies to every individual
empty-residue-baseline delta, not to an average across many deltas.

This bound does NOT apply when `baseline.residue` is non-empty. A delta
encoded from such a baseline must still re-embed everything preserved there
(see "Downlevel decode" and "Multi-hop transit" above - re-embedding on
every call is required for a receiving peer to recover content correctly,
not an implementation choice), and that content's size is inherent to what
was preserved, not to the current edit, so no fixed multiple of the current
edit's own size can bound it. The two behaviors this bound exists to rule
out - resending the entire tree instead of a delta, and needlessly
duplicating preserved content across unrelated deltas - are both still
caught: the first fails this bound on the (always empty-residue) first
delta from genesis, and the second is caught by the downlevel/multi-hop
fidelity requirements themselves, not by this bound.

## Tree validity and error handling

Trees must remain strictly acyclic. An `encode()` invocation containing a mutation that
would make a node a descendant of itself (creating a cycle across arbitrary depth),
attempting to move or delete the root node (`id === "root"`), inserting a duplicate ID
already in the tree, specifying an out-of-bounds child index, or naming a nonexistent
node or parent is invalid and must throw an Error. Similarly, a `decode()` invocation
with bytes not produced by a conforming `encode()` against the given baseline must throw
an Error.

## Determinism

Two `encode()` calls given identical `baseline`, `mutations`, and `version`
arguments must produce byte-identical output. Nothing else about the wire
representation is constrained - byte layout, field ordering, and the shape
of `residue` remain entirely the codec's own design - but for a fixed input
triple, that design's output must not vary from one call to the next (for
example, it must not embed a timestamp, random id, or iteration order over
an unordered structure that isn't itself part of the state).
