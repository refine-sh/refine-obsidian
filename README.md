<p align="center">
  <a href="https://refine.sh/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://refine.sh/icon-dark.png">
      <img src="https://refine.sh/icon.png" width="128" alt="Refine icon">
    </picture>
  </a>
</p>

<h1 align="center">Refine for Obsidian</h1>

<p align="center">
  <strong>A local-first AI grammar checker and writing assistant for Obsidian on Mac.</strong>
</p>

<p align="center">
  <a href="https://obsidian.md/plugins?id=refine"><strong>Install in Obsidian</strong></a>
  ·
  <a href="https://refine.sh/"><strong>Download Refine for Mac</strong></a>
</p>

Refine is an AI grammar checker powered by a local language model, so it can run
entirely offline. This plugin brings its contextual grammar, spelling, and
fluency suggestions to Obsidian, helping you improve your notes without leaving
your editor.

Features:

- Offline checks powered by a downloaded local LLM on your device
- Inline highlights and suggestion cards for reviewing changes in context
- Clear explanations of why each change is suggested

<!-- Demo GIF: replace this comment with:
![Refine grammar checker for Obsidian showing an inline suggestion, explanation, and accepted correction](assets/refine-obsidian-demo.gif)
-->

## Requirements

- macOS 14 or later
- Obsidian desktop 1.5.0 or later
- [Refine for Mac](https://refine.sh/) 1.35 or later

Refine includes a full-featured seven-day trial with no credit card required.

## Install

1. [Download Refine for Mac](https://refine.sh/), open it, and complete setup.
2. In Obsidian, open **Settings → Community plugins → Browse**.
3. Search for **Refine**, then select **Install** and **Enable**. You can also
   [open the Refine plugin in Obsidian](obsidian://show-plugin?id=refine).
4. Keep Refine running and open a Markdown note in Editing view. The plugin
   connects to Refine automatically.

## Check a note

Open a Markdown note in Editing view. With **Check Writing Automatically**
enabled (the default in Refine), the active note is checked after you pause
typing briefly.

1. Hover over highlighted text to open its suggestion card.
2. Review the change and inspect the language and model used for the check. If
   the action is available, choose **Explain** for more context.
3. Choose **Apply** to accept the correction or **Dismiss** to ignore it. When
   Refine offers **Report**, selecting it explicitly sends feedback about that
   live suggestion; reports are never submitted automatically.

The Refine icon in Obsidian's status bar shows the connection, checking
progress, and suggestion count. Select it to open the Refine menu. To check on
demand, open the Command Palette and run **Refine: Check current note**.

Suggestion colors, highlighting, automatic checks, local or hosted models, and
Quick Apply shortcuts are configured in the Refine app.

## Privacy and offline use

The plugin sends the complete active Markdown note to the Refine app over a
same-user Unix socket so Refine can check it. With a downloaded local model,
the source and model response stay on your Mac, and writing checks can run
without an internet connection after the model is downloaded.

To find the running Refine app, the plugin reads a small endpoint descriptor
file in `~/Library/Application Support/com.runjuu.refine/` outside your vault.
It reads no other files outside the vault.

Refine can also use hosted providers that you configure. In that case, requests
from the Refine app—including note source—may go to the selected provider and
are subject to that provider's privacy and retention policies.

**Report is separate from the writing-check provider.** Only choosing
**Report** on a live suggestion can send feedback to Refine's feedback service,
and only when Refine makes that action available. A report may contain original
and revised snippets plus language, provider, model, custom-instruction, Refine
version, and macOS version context. The plugin does not automatically report
suggestions.

This plugin does not send its own analytics or persist note source. It keeps the
active integration state in memory; Obsidian and any other installed plugins
have their own logging, telemetry, and retention behavior. App and model
downloads, updates, standard license activation and periodic validation,
hosted checks, and Report require internet access. An online-activated license
can continue through network errors for up to 21 days after its last successful
validation.

[Learn how Refine handles your writing](https://refine.sh/guides/how-refine-works)
or read the [privacy policy](https://refine.sh/privacy-policy).

## Troubleshooting

### Refine is not connected

Make sure Refine is installed, open, and up to date. Then select the Refine icon
in Obsidian's status bar to see the current connection state. The plugin
reconnects automatically after Refine restarts. If the exact Integration
Protocol versions differ, the plugin reports both versions and asks for a
compatible Refine/plugin pair; it does not guess which component is newer.

### Refine did not understand the plugin

The installed Refine app cannot read what this plugin sends, which happens when
Refine is older than the plugin. Update Refine for Mac, then reopen the note.

### No suggestions appear

Open a Markdown note in Editing view and confirm that your Refine trial or
license is active. Check the **Check Writing Automatically** setting in Refine,
or run **Refine: Check current note** from the Command Palette.

### A suggestion cannot be applied

Refine will not apply a stale correction if the note changed after it was
checked, or if the note is read-only. Check the current note again and review
the new suggestion.

## Frequently asked questions

### Is Refine a private Grammarly alternative for Obsidian?

Refine is a local-first AI writing assistant for Mac. With a downloaded local
model, it can check grammar, spelling, and fluency in Obsidian without sending
your writing to a cloud model. Refine requires its Mac app and an active trial
or license; it is not a standalone Obsidian plugin.

### Does Refine work completely offline?

Writing checks can run offline with a downloaded local model. Downloads,
updates, hosted models, and online license services still require a connection.
An online-activated license can continue through network errors for up to 21
days after its last successful validation. If you have a purchased lifetime
license, you can use
[Offline Activation](https://refine.sh/guides/offline-grammar-checker-mac) for
longer disconnected use.

### Does the plugin work on Windows, Linux, or mobile?

No. Refine for Obsidian currently requires the Refine app on macOS and therefore
works only in Obsidian desktop on Mac.

### Can Refine check an entire vault or Reading view?

No. The plugin checks the active Markdown note in Editing view. It does not run
vault-wide checks or check Reading view.

## Get started

Ready to use a local AI grammar checker in Obsidian?
[Download Refine for Mac](https://refine.sh/), then
[install Refine from Obsidian Community Plugins](https://obsidian.md/plugins?id=refine).

## Support

For plugin bugs and feature requests, open a
[GitHub issue](https://github.com/refine-sh/refine-obsidian/issues). For help with
the Refine app, email [support@refine.sh](mailto:support@refine.sh).

Refine supports same-user macOS writing-host clients connecting to the shipping
Refine server with exact Integration Protocol 1.0. Protocol 1.0 compatibility
is maintained throughout Refine 1.x. The support profile does not include
network transports, cross-user
access, other operating systems, sandbox workarounds, automatic app launch, or
third-party production servers, and it does not include an integration-
development SLA or certification program. Conformance is self-assessed; there
is no approval gate or compatibility badge.

The public statement “Compatible with Refine Protocol 1.0” has additional
conditions: each advertised release must pass the conformance suite and make
the source-flow, Report destination/data, explicit Report gesture, and client
telemetry/retention disclosures. See the protocol package's
[support profile](https://github.com/refine-sh/refine-protocol/blob/main/SUPPORT.md)
and
[compatibility-claim conditions](https://github.com/refine-sh/refine-protocol/blob/main/COMPATIBILITY-CLAIMS.md).

Refine for Obsidian is available under the [MIT License](LICENSE).

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

To run the protocol package's eight live AF_UNIX conformance scenarios against
the production transport/runtime seams, point the opt-in conformance command at
a local `refine-protocol` checkout:

```sh
REFINE_PROTOCOL_ROOT=/path/to/refine-protocol npm run test:conformance
```

This external-repository gate is intentionally separate from `npm test`; the
normal test suite does not require a protocol checkout.

For local testing, copy `manifest.json`, `main.js`, and `styles.css` into
`.obsidian/plugins/refine/` in a test vault, then reload Obsidian and enable
**Refine** under Community plugins.

The integration boundaries and safe-Apply semantics are documented in the
[Refine Integration Protocol 1.0 specification](https://github.com/refine-sh/refine-protocol/blob/main/spec/protocol.md),
which is the supported public wire.
It is an exact-version, local macOS client-to-Refine interface. Endpoint
permissions, peer-UID checks, and a per-launch token exclude other OS users and
nonlocal peers; self-reported client labels do not authenticate one process
from another process already running as the same user.
