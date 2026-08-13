# Refine for Obsidian

Refine for Obsidian presents writing suggestions directly in the Markdown
editor and applies accepted changes to canonical Markdown source in one
CodeMirror transaction. Live Preview showing or hiding Markdown syntax does not
change the text Refine validates or edits.

The plugin is desktop-only because it connects to the local Refine app through
an authenticated Unix-domain socket. Refine must be running.

## Development

```sh
npm install
npm test
npm run build
```

Copy `manifest.json`, `main.js`, and `styles.css` to
`.obsidian/plugins/refine/` in a test vault, then enable **Refine** under
Community plugins.

## Architecture

The package deliberately separates reusable integration behavior from host
code:

- `src/integration/` owns supersession, presentation replacement, reconnects,
  suggestion actions, and the safe-Apply receipt handshake.
- `src/transport/` owns the authenticated, length-prefixed Unix-socket
  protocol shared with the Refine app.
- `src/obsidian/` is the thin native adapter. It reads CodeMirror's canonical
  Markdown, renders decorations and suggestion cards, and performs exact
  source edits atomically.

External editor integrations should reuse the protocol and integration state
machine. They only replace the host adapter and native presentation.

## V1 behavior

- Automatic writing-check scheduling and policy live in the Refine app.
- **Refine: Check current note** requests an immediate check.
- Grammar and fluency suggestions are shown as native editor decorations.
- Apply and Dismiss are implemented. Explain and Report are already represented
  by the shared interface and become visible only when Refine advertises them.
- If Refine restarts, the plugin reconnects and reopens the latest complete
  Markdown snapshot.
- If an Apply may have reached Obsidian, the plugin never retries the mutation.
