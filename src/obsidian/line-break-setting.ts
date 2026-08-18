import type { EventRef, Vault } from "obsidian";

import type { SourceSnapshot } from "../integration/types";

export type ObsidianDocumentSyntax = Extract<
  SourceSnapshot["sourceSyntax"],
  "markdownDocument" | "markdownDocumentHardLineBreaks"
>;

/**
 * `Vault.getConfig` and the `config-changed` event exist on every supported
 * Obsidian build but are not part of the public typings, so this module is
 * the one place that reaches past them.
 */
interface VaultEditorConfig {
  getConfig?: (key: string) => unknown;
  on?: (
    name: string,
    callback: (...data: unknown[]) => unknown,
  ) => EventRef;
}

const STRICT_LINE_BREAKS_KEY = "strictLineBreaks";

/**
 * Obsidian ships "Strict line breaks" off and then renders every source line
 * ending as a line break, so only an explicit `true` — CommonMark rendering —
 * may relax the declaration to `markdownDocument`. A missing or unreadable
 * config surface keeps the line-preserving declaration, whose only failure
 * mode is a dropped suggestion, never a moved line ending.
 */
export function documentSourceSyntax(vault: Vault): ObsidianDocumentSyntax {
  const { getConfig } = vault as VaultEditorConfig;
  if (typeof getConfig !== "function") {
    return "markdownDocumentHardLineBreaks";
  }
  try {
    return getConfig.call(vault, STRICT_LINE_BREAKS_KEY) === true
      ? "markdownDocument"
      : "markdownDocumentHardLineBreaks";
  } catch {
    return "markdownDocumentHardLineBreaks";
  }
}

/**
 * Invokes `onChange` whenever the vault reports a configuration change that
 * may affect "Strict line breaks". The event delivers the changed key on
 * current builds; a build delivering nothing, or an unexpected payload,
 * still re-evaluates.
 * Returns undefined when the event surface is unavailable, in which case a
 * toggle is only picked up when something else refreshes the snapshot, such
 * as the next document change.
 */
export function onLineBreakSettingChange(
  vault: Vault,
  onChange: () => void,
): EventRef | undefined {
  const { on } = vault as VaultEditorConfig;
  if (typeof on !== "function") {
    return undefined;
  }
  return on.call(vault, "config-changed", (...data: unknown[]) => {
    // Re-evaluate unless a string key provably names a different setting:
    // both APIs are undocumented, so an unexpected payload shape must err
    // toward re-reading rather than silently pinning a stale declaration.
    const key = data[0];
    if (typeof key !== "string" || key === STRICT_LINE_BREAKS_KEY) {
      onChange();
    }
  });
}
