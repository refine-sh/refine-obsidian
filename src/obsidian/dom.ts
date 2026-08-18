// Obsidian installs its element helpers on every window it opens, popouts
// included, but only declares the global function form. Reaching them through
// the owning window keeps a detached element in the document that will show it.
interface ObsidianWindow extends Window {
  createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    info?: DomElementInfo,
  ): HTMLElementTagNameMap[K];
}

export function createElIn<K extends keyof HTMLElementTagNameMap>(
  ownerDocument: Document,
  tag: K,
  info?: DomElementInfo,
): HTMLElementTagNameMap[K] {
  return (ownerDocument.win as ObsidianWindow).createEl(tag, info);
}
