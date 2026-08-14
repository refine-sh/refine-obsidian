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

  it("reports when Obsidian resets a registered view for another document", () => {
    const changed = vi.fn();
    const registry = new ObsidianEditorRegistry(changed);
    const pane = document.createElement("div");
    document.body.append(pane);
    const view = new EditorView({
      parent: pane,
      state: EditorState.create({
        doc: "first document",
        extensions: [registry.extension],
      }),
    });
    changed.mockClear();

    view.setState(EditorState.create({
      doc: "second document",
      extensions: [registry.extension],
    }));

    expect(changed).toHaveBeenCalledTimes(2);
    expect(registry.findIn(pane)).toBe(view);
    expect(view.state.doc.toString()).toBe("second document");

    view.destroy();
    pane.remove();
  });
});
