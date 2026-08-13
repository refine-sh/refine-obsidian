// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import { ObsidianEditorRegistry } from "../../src/obsidian/editor-registry";

describe("ObsidianEditorRegistry", () => {
  it("finds editor views through the registered CodeMirror extension", () => {
    const changed = vi.fn();
    const registry = new ObsidianEditorRegistry(changed);
    const pane = document.createElement("div");
    document.body.append(pane);
    const view = new EditorView({
      parent: pane,
      state: EditorState.create({
        doc: "canonical Markdown",
        extensions: [registry.extension],
      }),
    });

    expect(registry.findIn(pane)).toBe(view);
    expect(changed).toHaveBeenCalledTimes(1);

    view.destroy();

    expect(registry.findIn(pane)).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
    pane.remove();
  });
});
