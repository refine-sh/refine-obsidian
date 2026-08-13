# Refine Obsidian Contributor Guidance

For changes to the host interface, integration lifecycle, source revisions,
suggestion actions, or Apply semantics, read the normative ADR first:

`https://github.com/runjuu/grammar/blob/main/docs/adr/0012-host-native-writing-check-integration-interface.md`

Keep ownership at these boundaries:

- `src/integration/` is host-neutral lifecycle and action coordination.
- `src/transport/` is editor-neutral protocol and connection behavior.
- `src/obsidian/` owns canonical Markdown capture, revision identity,
  decorations, suggestion cards, and one-transaction source mutation.

Exercise public seams in tests. Before handoff, typechecking, the full test
suite, and the production build must all pass.
