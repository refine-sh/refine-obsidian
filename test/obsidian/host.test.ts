// @vitest-environment jsdom

import { foldEffect, foldState, unfoldEffect } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  type Extension,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PresentationSnapshot,
  SuggestionActions,
} from "../../src/integration/types";
import {
  DEFAULT_PRESENTATION_APPEARANCE,
  DEFAULT_PRESENTATION_INTERACTION,
} from "../../src/integration/types";
import { ObsidianWritingHost } from "../../src/obsidian/host";

describe("ObsidianWritingHost", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const view of views) {
      view.destroy();
    }
    views.length = 0;
  });

  it("observes the current canonical Markdown before later document revisions", async () => {
    const view = createView("[create an link](URL)or");
    const host = new ObsidianWritingHost(view, { sessionId: "test" });
    const controller = new AbortController();
    const observations = host.observe(controller.signal)[Symbol.asyncIterator]();

    await expect(observations.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "snapshot",
        snapshot: {
          revision: "test:0",
          sources: [
            {
              sourceId: "document",
              sourceSyntax: "markdownDocument",
              text: "[create an link](URL)or",
            },
          ],
        },
      },
    });
    await expect(observations.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "attentionChanged",
        revision: "test:0",
      },
    });

    view.dispatch({ changes: { from: 8, to: 10, insert: "a" } });

    await expect(observations.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "snapshot",
        snapshot: {
          revision: "test:1",
          sources: [{ text: "[create a link](URL)or" }],
        },
      },
    });
    await expect(observations.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "attentionChanged",
        revision: "test:1",
      },
    });

    controller.abort();
    await observations.return?.();
    host.close();
  });

  it("reports the current caret and visible source after the initial snapshot", async () => {
    const view = createView("A😀B");
    view.dispatch({ selection: { anchor: 3 } });
    const host = new ObsidianWritingHost(view, { sessionId: "attention" });
    const controller = new AbortController();
    const observations = host.observe(controller.signal)[Symbol.asyncIterator]();

    await expect(observations.next()).resolves.toMatchObject({
      done: false,
      value: { type: "snapshot", snapshot: { revision: "attention:0" } },
    });
    const attention = await Promise.race([
      observations.next(),
      new Promise<{ readonly timedOut: true }>((resolve) => {
        setTimeout(() => resolve({ timedOut: true }), 0);
      }),
    ]);

    expect(attention).toEqual({
      done: false,
      value: {
        type: "attentionChanged",
        revision: "attention:0",
        attention: {
          sourceId: "document",
          caretOffset: 3,
          visibleRanges: [{ location: 0, length: 4 }],
        },
      },
    });

    controller.abort();
    await observations.return?.();
    host.close();
  });

  it("updates attention without inventing a caret for a noncollapsed selection", async () => {
    const view = createView("abcdef");
    const host = new ObsidianWritingHost(view, { sessionId: "selection-attention" });
    const controller = new AbortController();
    const observations = host.observe(controller.signal)[Symbol.asyncIterator]();
    await observations.next();
    await observations.next();

    view.dispatch({ selection: { anchor: 1, head: 4 } });

    await expect(nextSoon(observations)).resolves.toEqual({
      done: false,
      value: {
        type: "attentionChanged",
        revision: "selection-attention:0",
        attention: {
          sourceId: "document",
          visibleRanges: [{ location: 0, length: 6 }],
        },
      },
    });

    controller.abort();
    await observations.return?.();
    host.close();
  });

  it("omits the caret when the editor has multiple selections", async () => {
    const view = createView("abcdef", [EditorState.allowMultipleSelections.of(true)]);
    const host = new ObsidianWritingHost(view, { sessionId: "multi-selection-attention" });
    const controller = new AbortController();
    const observations = host.observe(controller.signal)[Symbol.asyncIterator]();
    await observations.next();
    await observations.next();

    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(1),
        EditorSelection.cursor(4),
      ]),
    });

    await expect(nextSoon(observations)).resolves.toEqual({
      done: false,
      value: {
        type: "attentionChanged",
        revision: "multi-selection-attention:0",
        attention: {
          sourceId: "document",
          visibleRanges: [{ location: 0, length: 6 }],
        },
      },
    });

    controller.abort();
    await observations.return?.();
    host.close();
  });

  it("coalesces adjacent same-revision attention to the newest coordinates", async () => {
    const view = createView("abcdef");
    const host = new ObsidianWritingHost(view, { sessionId: "coalesced-attention" });
    const controller = new AbortController();
    const observations = host.observe(controller.signal)[Symbol.asyncIterator]();
    await observations.next();
    await observations.next();

    view.dispatch({ selection: { anchor: 1 } });
    view.dispatch({ selection: { anchor: 2 } });
    view.dispatch({ selection: { anchor: 3 } });

    await expect(observations.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "attentionChanged",
        revision: "coalesced-attention:0",
        attention: { caretOffset: 3 },
      },
    });

    controller.abort();
    await observations.return?.();
    host.close();
  });

  it("reports disjoint visible ranges when a fold hides source", async () => {
    const view = createView("before hidden after", [foldState]);
    const host = new ObsidianWritingHost(view, { sessionId: "fold-attention" });
    const controller = new AbortController();
    const observations = host.observe(controller.signal)[Symbol.asyncIterator]();
    await observations.next();
    await observations.next();

    view.dispatch({ effects: foldEffect.of({ from: 7, to: 13 }) });

    await expect(nextSoon(observations)).resolves.toEqual({
      done: false,
      value: {
        type: "attentionChanged",
        revision: "fold-attention:0",
        attention: {
          sourceId: "document",
          caretOffset: 0,
          visibleRanges: [
            { location: 0, length: 7 },
            { location: 13, length: 6 },
          ],
        },
      },
    });

    view.dispatch({ effects: unfoldEffect.of({ from: 7, to: 13 }) });

    await expect(nextSoon(observations)).resolves.toEqual({
      done: false,
      value: {
        type: "attentionChanged",
        revision: "fold-attention:0",
        attention: {
          sourceId: "document",
          caretOffset: 0,
          visibleRanges: [{ location: 0, length: 19 }],
        },
      },
    });

    await expect(host.validateRevision("fold-attention:0")).resolves.toEqual({
      status: "current",
    });

    controller.abort();
    await observations.return?.();
    host.close();
  });

  it("retains attention on focus loss and refreshes it on focus return", async () => {
    const view = createView("abcdef");
    const host = new ObsidianWritingHost(view, { sessionId: "focus-attention" });
    const controller = new AbortController();
    const observations = host.observe(controller.signal)[Symbol.asyncIterator]();
    await observations.next();
    await observations.next();

    view.contentDOM.focus();
    await expect(observations.next()).resolves.toMatchObject({
      value: {
        type: "attentionChanged",
        revision: "focus-attention:0",
      },
    });

    const afterFocusLoss = observations.next();
    view.contentDOM.blur();
    await new Promise((resolve) => setTimeout(resolve, 25));
    view.dispatch({ selection: { anchor: 3 } });
    await expect(Promise.race([
      afterFocusLoss.then(() => "observation" as const),
      new Promise<"no-observation">((resolve) => {
        setTimeout(() => resolve("no-observation"), 25);
      }),
    ])).resolves.toBe("no-observation");

    view.contentDOM.focus();
    await expect(afterFocusLoss).resolves.toMatchObject({
      value: {
        type: "attentionChanged",
        revision: "focus-attention:0",
        attention: { caretOffset: 3 },
      },
    });

    controller.abort();
    await observations.return?.();
    host.close();
  });

  it("keeps cursor-only presentation changes on the same revision", async () => {
    const view = createView("[label](URL)");
    const host = new ObsidianWritingHost(view, { sessionId: "cursor" });
    const controller = new AbortController();
    const observations = host.observe(controller.signal)[Symbol.asyncIterator]();
    const initial = await observations.next();
    if (initial.done || initial.value.type !== "snapshot") {
      throw new Error("expected an initial snapshot");
    }

    view.dispatch({ selection: { anchor: 2 } });

    await expect(host.validateRevision(initial.value.snapshot.revision)).resolves.toEqual({
      status: "current",
    });

    view.dispatch({ changes: { from: 1, to: 1, insert: "x" } });

    await expect(host.validateRevision(initial.value.snapshot.revision)).resolves.toMatchObject({
      status: "stale",
      snapshot: {
        revision: "cursor:1",
        sources: [{ text: "[xlabel](URL)" }],
      },
    });

    controller.abort();
    await observations.return?.();
    host.close();
  });

  it("applies coupled Markdown edits in one transaction without moving the selection", async () => {
    let documentTransactions = 0;
    const view = createView("[create an link](URL)or", [
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          documentTransactions += 1;
        }
      }),
    ]);
    view.dispatch({ selection: { anchor: 11, head: 15 } });
    const host = new ObsidianWritingHost(view, { sessionId: "apply" });
    const controller = new AbortController();
    const observations = host.observe(controller.signal)[Symbol.asyncIterator]();
    const initial = await observations.next();
    if (initial.done || initial.value.type !== "snapshot") {
      throw new Error("expected an initial snapshot");
    }

    const outcome = await host.apply({
      expectedRevision: initial.value.snapshot.revision,
      sourceId: "document",
      edits: [
        {
          range: { location: 21, length: 0 },
          expectedText: "",
          replacement: " ",
        },
        {
          range: { location: 8, length: 2 },
          expectedText: "an",
          replacement: "a",
        },
      ],
    });

    expect(outcome).toMatchObject({
      status: "applied",
      snapshot: {
        revision: "apply:1",
        sources: [{ text: "[create a link](URL) or" }],
      },
    });
    expect(documentTransactions).toBe(1);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "link",
    );

    controller.abort();
    await observations.return?.();
    host.close();
  });

  it("rejects a stale revision without changing Markdown", async () => {
    const view = createView("create an link");
    const host = new ObsidianWritingHost(view, { sessionId: "stale" });

    const outcome = await host.apply({
      expectedRevision: "stale:99",
      sourceId: "document",
      edits: [
        {
          range: { location: 7, length: 2 },
          expectedText: "an",
          replacement: "a",
        },
      ],
    });

    expect(outcome).toMatchObject({
      status: "rejected",
      reason: "staleRevision",
      snapshot: { sources: [{ text: "create an link" }] },
    });
    expect(view.state.doc.toString()).toBe("create an link");
    host.close();
  });

  it("rejects an expected-text mismatch without changing Markdown", async () => {
    const view = createView("create an link");
    const host = new ObsidianWritingHost(view, { sessionId: "mismatch" });

    const outcome = await host.apply({
      expectedRevision: "mismatch:0",
      sourceId: "document",
      edits: [
        {
          range: { location: 7, length: 2 },
          expectedText: "the",
          replacement: "a",
        },
      ],
    });

    expect(outcome).toMatchObject({
      status: "rejected",
      reason: "textMismatch",
      snapshot: { sources: [{ text: "create an link" }] },
    });
    expect(view.state.doc.toString()).toBe("create an link");
    host.close();
  });

  it("applies an edit at a scalar boundary inside one displayed grapheme", async () => {
    const view = createView("e\u0301");
    const host = new ObsidianWritingHost(view, { sessionId: "scalar" });

    const outcome = await host.apply({
      expectedRevision: "scalar:0",
      sourceId: "document",
      edits: [
        {
          range: { location: 0, length: 1 },
          expectedText: "e",
          replacement: "a",
        },
      ],
    });

    expect(outcome).toMatchObject({ status: "applied" });
    expect(view.state.doc.toString()).toBe("a\u0301");
    host.close();
  });

  it("rejects an edit that splits a surrogate pair", async () => {
    const view = createView("A😀B");
    const host = new ObsidianWritingHost(view, { sessionId: "unicode" });

    const outcome = await host.apply({
      expectedRevision: "unicode:0",
      sourceId: "document",
      edits: [
        {
          range: { location: 2, length: 0 },
          expectedText: "",
          replacement: "x",
        },
      ],
    });

    expect(outcome).toMatchObject({ status: "unavailable" });
    expect(view.state.doc.toString()).toBe("A😀B");
    host.close();
  });

  it("activates one editor extension per session without leaving it behind", () => {
    const view = createView("draft");
    const initialListenerCount = view.state.facet(EditorView.updateListener).length;

    const first = new ObsidianWritingHost(view, { sessionId: "first" });
    const installedListenerCount = view.state.facet(EditorView.updateListener).length;
    first.close();
    const closedListenerCount = view.state.facet(EditorView.updateListener).length;
    const second = new ObsidianWritingHost(view, { sessionId: "second" });
    const reinstalledListenerCount = view.state.facet(EditorView.updateListener).length;

    expect(installedListenerCount).toBe(initialListenerCount + 1);
    expect(closedListenerCount).toBe(initialListenerCount);
    expect(reinstalledListenerCount).toBe(installedListenerCount);
    expect(second.isAttached()).toBe(true);
    second.close();
    expect(view.state.facet(EditorView.updateListener)).toHaveLength(initialListenerCount);
  });

  it("reattaches after Obsidian resets one editor view for another document", async () => {
    const view = createView("first note");
    const first = new ObsidianWritingHost(view, { sessionId: "first" });

    view.setState(EditorState.create({ doc: "second note" }));

    expect(first.isAttached()).toBe(false);
    first.close();

    const second = new ObsidianWritingHost(view, { sessionId: "second" });
    const controller = new AbortController();
    const observations = second.observe(controller.signal)[Symbol.asyncIterator]();

    expect(second.isAttached()).toBe(true);
    expect(view.state.facet(EditorView.updateListener)).toHaveLength(1);
    await expect(observations.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "snapshot",
        snapshot: {
          revision: "second:0",
          sources: [{ text: "second note" }],
        },
      },
    });

    controller.abort();
    await observations.return?.();
    second.close();
  });

  it("reports a presentation installed for the current document", () => {
    const view = createView("draft");
    const onPresentation = vi.fn();
    const host = new ObsidianWritingHost(view, {
      sessionId: "presented",
      onPresentation,
    });
    const snapshot = pendingPresentation("presented:0");

    host.present(snapshot, inertActions());

    expect(onPresentation).toHaveBeenCalledOnce();
    expect(onPresentation).toHaveBeenCalledWith(snapshot);
    host.close();
  });

  it("does not report a presentation for a retired document revision", () => {
    const view = createView("draft");
    const onPresentation = vi.fn();
    const host = new ObsidianWritingHost(view, {
      sessionId: "retired",
      onPresentation,
    });
    view.dispatch({ changes: { from: 5, insert: " updated" } });

    host.present(pendingPresentation("retired:0"), inertActions());

    expect(onPresentation).not.toHaveBeenCalled();
    host.close();
  });

  function createView(doc: string, extensions: readonly Extension[] = []): EditorView {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc, extensions }),
    });
    views.push(view);
    return view;
  }
});

function pendingPresentation(revision: string): PresentationSnapshot {
  return {
    documentRevision: revision,
    presentationRevision: 1,
    checkGeneration: 0,
    appearance: DEFAULT_PRESENTATION_APPEARANCE,
    interaction: DEFAULT_PRESENTATION_INTERACTION,
    state: { type: "pending" },
    suggestions: [],
  };
}

function inertActions(): SuggestionActions {
  return {
    apply: async () => ({ status: "completed" }),
    dismiss: async () => ({ status: "completed" }),
    explain: async function* () {
      return;
    },
    report: async () => ({ status: "completed" }),
  };
}

async function nextSoon<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>> {
  const result = await Promise.race([
    iterator.next(),
    new Promise<"timedOut">((resolve) => {
      setTimeout(() => resolve("timedOut"), 0);
    }),
  ]);
  if (result === "timedOut") {
    throw new Error("expected an observation without waiting for another host event");
  }
  return result;
}
