# Refine Obsidian Contributor Guidance

For changes to the host interface, integration lifecycle, source revisions,
suggestion actions, or Apply semantics, read the normative specification
first:

`https://github.com/refine-sh/refine-protocol/blob/main/spec/protocol.md`

Keep ownership at these boundaries:

- `src/integration/` is host-neutral lifecycle and action coordination.
- `src/transport/` is editor-neutral protocol and connection behavior.
- `src/obsidian/` owns canonical Markdown capture, revision identity,
  decorations, suggestion cards, and one-transaction source mutation.

Exercise public seams in tests. Before handoff, linting, typechecking, the
full test suite, and the production build must all pass.
