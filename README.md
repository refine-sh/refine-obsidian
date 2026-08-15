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

## V2.4 behavior

- Automatic writing-check scheduling and policy live in the Refine app.
- **Refine: Check current note** requests an immediate check from the Command
  Palette. The status menu shows the same action only while automatic checks
  are disabled or temporarily paused.
- Refine automatically checks a changed note after a short quiet period when
  **Check Writing Automatically** is enabled in the Refine app.
- The bottom status-bar icon shows connection, checking, and suggestion state;
  activate it to open the Refine menu.
- Grammar and fluency suggestions are shown as native editor decorations.
- Highlight style, grammar/fluency colors, diff colors, and hidden-whitespace
  markers follow Refine's appearance settings without requiring another check.
- Quick Apply enablement, activation style, and interaction shortcuts follow
  Refine's settings without requiring another check. An open suggestion card
  also accepts Refine's configured Apply and Dismiss keys, even when cursor
  activation is disabled. Dismiss on an open card records an explicit
  dismissal; Dismiss during cursor activation alone only clears activation.
- Native and Obsidian writing checks use the same active-trial-or-license
  entitlement. When it is missing, the session stays connected and exposes an
  actionable unavailable state without starting a check.
- Suggestion cards show the check language and model attribution supplied by
  Refine. Explain streams Refine's native Markdown explanation and identifies
  its independently selected model.
- Report uses Refine's native suggestion-feedback service, keeps the card open,
  and is shown only while suggestion feedback is enabled in Refine.
- If Refine restarts, the plugin reconnects and reopens the latest complete
  Markdown snapshot.
- If an Apply may have reached Obsidian, the plugin never retries the mutation.
