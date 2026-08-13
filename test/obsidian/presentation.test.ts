// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ExplanationUpdate,
  PresentationSnapshot,
  SuggestionActions,
} from "../../src/integration/types";
import { ObsidianWritingHost } from "../../src/obsidian/host";

describe("Obsidian presentation", () => {
  const hosts: ObsidianWritingHost[] = [];
  const views: EditorView[] = [];

  afterEach(() => {
    for (const host of hosts) {
      host.close();
    }
    for (const view of views) {
      view.destroy();
    }
    hosts.length = 0;
    views.length = 0;
    document.body.replaceChildren();
  });

  it("replaces highlights and insertion anchors as one presentation", async () => {
    const { host } = createHost("[create an link](URL)or", "present");

    await host.present(presentation("present:0"), actions());

    expect(document.querySelectorAll(".refine-suggestion")).toHaveLength(1);
    expect(document.querySelectorAll(".refine-insertion-anchor")).toHaveLength(1);

    await host.present(
      {
        documentRevision: "present:0",
        presentationRevision: 2,
        state: { type: "complete", coverage: "full" },
        suggestions: [],
      },
      actions(),
    );

    expect(document.querySelectorAll(".refine-suggestion, .refine-insertion-anchor")).toHaveLength(0);
  });

  it("clears stale suggestion UI synchronously when Markdown changes", async () => {
    const { host, view } = createHost("[create an link](URL)or", "stale-ui");
    await host.present(presentation("stale-ui:0"), actions());
    expect(document.querySelector(".refine-suggestion")).not.toBeNull();

    view.dispatch({ changes: { from: 8, to: 10, insert: "a" } });

    expect(document.querySelector(".refine-suggestion, .refine-insertion-anchor")).toBeNull();
  });

  it("forwards an opaque suggestion action from the native suggestion card", async () => {
    const { host } = createHost("[create an link](URL)or", "action");
    const apply = vi.fn(async () => ({ status: "completed" as const }));
    await host.present(presentation("action:0"), actions({ apply }));

    const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
    expect(highlight).not.toBeNull();
    highlight?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const button = document.querySelector<HTMLButtonElement>(".refine-tooltip button");
    expect(button?.textContent).toBe("Apply");

    button?.click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith("grammar-1"));
  });

  it("opens a suggestion card from the keyboard without changing editor selection", async () => {
    const { host, view } = createHost("[create an link](URL)or", "keyboard");
    view.dispatch({ selection: { anchor: 8, head: 10 } });
    await host.present(presentation("keyboard:0"), actions());
    const highlight = document.querySelector<HTMLElement>(".refine-suggestion");

    highlight?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(document.querySelector(".refine-tooltip")).not.toBeNull();
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "an",
    );
  });

  function createHost(doc: string, sessionId: string): {
    host: ObsidianWritingHost;
    view: EditorView;
  } {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc }),
    });
    const host = new ObsidianWritingHost(view, { sessionId });
    hosts.push(host);
    views.push(view);
    return { host, view };
  }
});

function presentation(revision: string): PresentationSnapshot {
  return {
    documentRevision: revision,
    presentationRevision: 1,
    state: { type: "complete", coverage: "full" },
    suggestions: [
      {
        id: "grammar-1",
        sourceId: "document",
        kind: "grammar",
        highlightRanges: [
          { location: 8, length: 2 },
          { location: 21, length: 0 },
        ],
        diff: [
          { kind: "unchanged", text: "create " },
          { kind: "delete", text: "an" },
          { kind: "insert", text: "a" },
          { kind: "unchanged", text: " link or" },
          { kind: "insert", text: " " },
        ],
        availableActions: ["apply"],
      },
    ],
  };
}

function actions(overrides: Partial<SuggestionActions> = {}): SuggestionActions {
  return {
    apply: async () => ({ status: "completed" }),
    dismiss: async () => ({ status: "completed" }),
    explain: (): AsyncIterable<ExplanationUpdate> => emptyExplanation(),
    report: async () => ({ status: "completed" }),
    ...overrides,
  };
}

async function* emptyExplanation(): AsyncIterable<ExplanationUpdate> {
  return;
}
