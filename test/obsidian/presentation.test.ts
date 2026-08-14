// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRefineIntegration } from "../../src/integration/refine-integration";
import type {
  ExplanationUpdate,
  PresentationSnapshot,
  SuggestionActions,
} from "../../src/integration/types";
import { DEFAULT_PRESENTATION_APPEARANCE } from "../../src/integration/types";
import { ObsidianWritingHost } from "../../src/obsidian/host";
import { AsyncQueue } from "../../src/shared/async-queue";
import type {
  CommandReceipt,
  RefineTransportSession,
} from "../../src/transport/refine-transport";
import type {
  ClientCommand,
  ServerEventEnvelope,
} from "../../src/transport/wire";

if (typeof Range.prototype.getClientRects !== "function") {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
}
if (typeof Range.prototype.getBoundingClientRect !== "function") {
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}

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
        appearance: DEFAULT_PRESENTATION_APPEARANCE,
        state: { type: "complete", coverage: "full" },
        suggestions: [],
      },
      actions(),
    );

    expect(document.querySelectorAll(".refine-suggestion, .refine-insertion-anchor")).toHaveLength(0);
  });

  it("keeps only mapped unaffected suggestions as inert provisional decorations", async () => {
    const { host, view } = createHost(
      "bad first. bad second.",
      "provisional",
    );
    const apply = vi.fn(async () => ({ status: "completed" as const }));
    await host.present(
      separatedSuggestionPresentation("provisional:0"),
      actions({ apply }),
    );
    const liveSecond = [...document.querySelectorAll<HTMLElement>(
      ".refine-suggestion",
    )].find((element) => view.posAtDOM(element, 0) === 11);
    expect(liveSecond).not.toBeUndefined();
    if (!liveSecond) {
      throw new Error("expected the second live suggestion");
    }
    await hover(view, liveSecond, 12);
    expect(document.querySelector(".refine-tooltip")).not.toBeNull();

    view.dispatch({ changes: { from: 1, insert: "x" } });

    const provisional = document.querySelectorAll<HTMLElement>(
      ".refine-suggestion",
    );
    const anchor = document.querySelector<HTMLElement>(
      ".refine-insertion-anchor",
    );
    expect(provisional).toHaveLength(1);
    expect(view.posAtDOM(provisional[0]!, 0)).toBe(12);
    expect(provisional[0]?.textContent).toBe("bad");
    expect(provisional[0]?.dataset.refineSuggestionId).toBeUndefined();
    expect(provisional[0]?.hasAttribute("role")).toBe(false);
    expect(provisional[0]?.hasAttribute("tabindex")).toBe(false);
    expect(provisional[0]?.hasAttribute("aria-label")).toBe(false);
    expect(provisional[0]?.hasAttribute("aria-hidden")).toBe(false);
    expect(provisional[0]?.classList).toContain(
      "refine-suggestion--provisional",
    );
    expect(anchor).not.toBeNull();
    expect(view.posAtDOM(anchor!, 0)).toBe(22);
    expect(anchor?.dataset.refineSuggestionId).toBeUndefined();
    expect(anchor?.hasAttribute("role")).toBe(false);
    expect(anchor?.hasAttribute("tabindex")).toBe(false);
    expect(anchor?.getAttribute("aria-hidden")).toBe("true");
    expect(anchor?.style.pointerEvents).toBe("none");
    expect(document.querySelector(".refine-tooltip")).toBeNull();

    provisional[0]?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    provisional[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();

    // Touching the mapped zero-width fragment in a later transaction drops its
    // whole group, proving successive edits use the remapped range metadata.
    view.dispatch({
      changes: { from: view.posAtDOM(anchor!, 0), insert: "!" },
    });
    expect(document.querySelector(
      ".refine-suggestion, .refine-insertion-anchor",
    )).toBeNull();
  });

  it("keeps live suggestion actions after a same-text replacement", async () => {
    const { host, view } = createHost(
      "bad first. bad second.",
      "same-text",
    );
    const apply = vi.fn(async () => ({ status: "completed" as const }));
    await host.present(
      separatedSuggestionPresentation("same-text:0"),
      actions({ apply }),
    );

    view.dispatch({ changes: { from: 0, to: 3, insert: "bad" } });

    const highlight = document.querySelector<HTMLElement>(
      "[data-refine-suggestion-id=first]",
    );
    expect(highlight).not.toBeNull();
    highlight?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    const button = document.querySelector<HTMLButtonElement>(
      ".refine-tooltip button",
    );
    expect(button?.textContent).toBe("Apply");
    button?.click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith("first"));
  });

  it("returns focus to the editor when a live highlight becomes provisional", async () => {
    const { host, view } = createHost(
      "bad first. bad second.",
      "provisional-focus",
    );
    await host.present(
      separatedSuggestionPresentation("provisional-focus:0"),
      actions(),
    );
    view.dispatch({ selection: { anchor: 15 } });
    const highlight = [...document.querySelectorAll<HTMLElement>(
      "[data-refine-suggestion-id]",
    )].find((element) => view.posAtDOM(element, 0) === 11);
    expect(highlight).not.toBeUndefined();
    highlight?.focus();
    expect(document.activeElement).toBe(highlight);

    view.dispatch({ changes: { from: 1, insert: "x" } });

    expect(document.activeElement).toBe(view.contentDOM);
    expect(view.state.selection.main.anchor).toBe(16);
    expect(document.querySelector(
      ".refine-suggestion--provisional",
    )).not.toBeNull();
  });

  it("maps atomic old-coordinate changes across an astral prefix", async () => {
    const { host, view } = createHost(
      "😀 bad first. bad second.",
      "atomic-utf16",
    );
    await host.present(
      separatedSuggestionPresentation("atomic-utf16:0", 3),
      actions(),
    );

    view.dispatch({
      changes: [
        { from: 0, to: 2, insert: "😀😀" },
        { from: 4, insert: "x" },
        { from: 13, insert: "!" },
      ],
    });

    const provisional = document.querySelectorAll<HTMLElement>(
      ".refine-suggestion",
    );
    const anchor = document.querySelector<HTMLElement>(
      ".refine-insertion-anchor",
    );
    expect(provisional).toHaveLength(1);
    expect(view.posAtDOM(provisional[0]!, 0)).toBe(18);
    expect(view.posAtDOM(anchor!, 0)).toBe(28);
    expect(provisional[0]?.dataset.refineSuggestionId).toBeUndefined();
    expect(anchor?.dataset.refineSuggestionId).toBeUndefined();
  });

  it("drops every fragment of a suggestion when one highlight is touched", async () => {
    const { host, view } = createHost(
      "bad first. bad second.",
      "provisional-group",
    );
    await host.present(
      separatedSuggestionPresentation("provisional-group:0"),
      actions(),
    );

    view.dispatch({ changes: { from: 12, insert: "x" } });

    const remaining = document.querySelectorAll<HTMLElement>(
      ".refine-suggestion",
    );
    expect(remaining).toHaveLength(1);
    expect(view.posAtDOM(remaining[0]!, 0)).toBe(0);
    expect(document.querySelector(".refine-insertion-anchor")).toBeNull();
  });

  it("carries unaffected provisional decorations through a host Apply receipt", async () => {
    const { host, view } = createHost(
      "bad first. bad second.",
      "provisional-apply",
    );
    await host.present(
      separatedSuggestionPresentation("provisional-apply:0"),
      actions(),
    );

    const outcome = await host.apply({
      expectedRevision: "provisional-apply:0",
      sourceId: "document",
      edits: [{
        range: { location: 0, length: 3 },
        expectedText: "bad",
        replacement: "poor",
      }],
    });
    if (outcome.status !== "applied") {
      throw new Error("expected the host Apply to succeed");
    }

    const provisional = document.querySelector<HTMLElement>(
      ".refine-suggestion",
    );
    expect(provisional).not.toBeNull();
    expect(view.posAtDOM(provisional!, 0)).toBe(12);
    expect(document.querySelector(".refine-insertion-anchor")).not.toBeNull();

    await host.present(
      lifecyclePresentation(outcome.snapshot.revision, 2, { type: "pending" }),
      actions(),
    );
    expect(document.querySelector(".refine-suggestion")).toBe(provisional);
  });

  it.each([
    { type: "checking" as const },
    { type: "complete" as const, coverage: "full" as const },
    { type: "unavailable" as const, reason: "checkFailed" as const },
    { type: "closed" as const },
  ])(
    "preserves provisional decorations through pending, then clears them on $type",
    async (state) => {
      const { host, view } = createHost(
        "bad first. bad second.",
        `provisional-${state.type}`,
      );
      await host.present(
        separatedSuggestionPresentation(`provisional-${state.type}:0`),
        actions(),
      );

      view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } });
      expect(document.querySelectorAll(
        ".refine-suggestion, .refine-insertion-anchor",
      )).toHaveLength(3);

      await host.present(
        lifecyclePresentation(`provisional-${state.type}:1`, 2, { type: "pending" }),
        actions(),
      );
      expect(document.querySelectorAll(
        ".refine-suggestion, .refine-insertion-anchor",
      )).toHaveLength(3);

      await host.present(
        lifecyclePresentation(`provisional-${state.type}:1`, 3, state),
        actions(),
      );
      expect(document.querySelector(
        ".refine-suggestion, .refine-insertion-anchor",
      )).toBeNull();
    },
  );

  it("ignores a stale presentation while provisional decorations await the current revision", async () => {
    const { host, view } = createHost(
      "bad first. bad second.",
      "provisional-stale",
    );
    await host.present(
      separatedSuggestionPresentation("provisional-stale:0"),
      actions(),
    );
    view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } });

    await host.present(
      lifecyclePresentation("provisional-stale:0", 2, { type: "pending" }),
      actions(),
    );

    expect(document.querySelectorAll(
      ".refine-suggestion, .refine-insertion-anchor",
    )).toHaveLength(3);
  });

  it("clears a live presentation when the host receives a mismatched revision", async () => {
    const { host, view } = createHost(
      "bad first. bad second.",
      "live-mismatch",
    );
    const apply = vi.fn(async () => ({ status: "completed" as const }));
    await host.present(
      separatedSuggestionPresentation("live-mismatch:0"),
      actions({ apply }),
    );
    const highlight = document.querySelector<HTMLElement>(
      "[data-refine-suggestion-id]",
    );
    expect(highlight).not.toBeNull();
    await hover(view, highlight, 1);
    expect(document.querySelector(".refine-tooltip")).not.toBeNull();
    expect(document.querySelector(".refine-tooltip button")?.textContent).toBe(
      "Apply",
    );

    await host.present(
      lifecyclePresentation("some-other-revision", 2, { type: "pending" }),
      actions(),
    );

    expect(document.querySelector(
      ".refine-suggestion, .refine-insertion-anchor",
    )).toBeNull();
    expect(document.querySelector(".refine-tooltip")).toBeNull();
    expect(document.querySelector(".refine-tooltip button")).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it("forwards an opaque suggestion action from the native suggestion card", async () => {
    const { host, view } = createHost("[create an link](URL)or", "action");
    const apply = vi.fn(async () => ({ status: "completed" as const }));
    await host.present(presentation("action:0"), actions({ apply }));

    const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
    expect(highlight).not.toBeNull();
    await hover(view, highlight, 9);
    const button = document.querySelector<HTMLButtonElement>(".refine-tooltip button");
    expect(button?.textContent).toBe("Apply");

    button?.click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith("grammar-1"));
  });

  it("shows native-style attribution and streams an explanation with its model", async () => {
    const rendered: string[] = [];
    const renderExplanation = vi.fn((markdown: string, element: HTMLElement) => {
      rendered.push(markdown);
      element.textContent = `rendered:${markdown}`;
    });
    const { host, view } = createHost(
      "[create an link](URL)or",
      "explain",
      [],
      renderExplanation,
    );
    async function* explain(): AsyncIterable<ExplanationUpdate> {
      yield {
        status: "started",
        attribution: {
          languageDisplayName: "English (American)",
          textDirection: "ltr",
          modelDisplayName: "OpenRouter (GPT-5.6)",
        },
      };
      yield { status: "streaming", text: "First line.\nPartial" };
      yield { status: "completed", text: "First line.\nSecond line." };
    }
    const baseSnapshot = presentation("explain:0");
    const snapshot: PresentationSnapshot = {
      ...baseSnapshot,
      suggestions: baseSnapshot.suggestions.map((suggestion) => ({
        ...suggestion,
        availableActions: ["apply", "dismiss", "explain", "report"],
      })),
    };
    await host.present(snapshot, actions({ explain }));
    await hover(view, document.querySelector(".refine-suggestion"), 9);

    expect(document.querySelector(".refine-tooltip__caption")?.textContent).toBe(
      "Grammar - English (American)",
    );
    expect(document.querySelector(".refine-tooltip__model")?.textContent).toBe("");
    const explainButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Explain");
    explainButton?.click();

    await vi.waitFor(() => expect(rendered.at(-1)).toBe("First line.\nSecond line."));
    expect(document.querySelector(".refine-tooltip__model")?.textContent).toBe(
      "On-Device (Gemma 4 E4B)",
    );
    expect(document.querySelector(".refine-tooltip__explanation-section")?.textContent)
      .toContain("Explanation - English (American)");
    expect(document.querySelector(".refine-tooltip__explanation-section")?.textContent)
      .toContain("OpenRouter (GPT-5.6)");
    expect(document.querySelector(".refine-tooltip__explanation")?.textContent).toBe(
      "rendered:First line.\nSecond line.",
    );
  });

  it("makes Explain retryable when it is rejected before starting", async () => {
    let attempt = 0;
    async function* rejected(): AsyncIterable<ExplanationUpdate> {
      yield { status: "unavailable", reason: "engineUnavailable" };
    }
    async function* completed(): AsyncIterable<ExplanationUpdate> {
      yield {
        status: "started",
        attribution: {
          languageDisplayName: "English (American)",
          textDirection: "ltr",
          modelDisplayName: "On-Device (Gemma)",
        },
      };
      yield { status: "completed", text: "Explanation." };
    }
    const explain = vi.fn(() => {
      attempt += 1;
      return attempt === 1 ? rejected() : completed();
    });
    const { host, view } = createHost("[create an link](URL)or", "explain-retry");
    const baseSnapshot = presentation("explain-retry:0");
    await host.present(
      {
        ...baseSnapshot,
        suggestions: baseSnapshot.suggestions.map((suggestion) => ({
          ...suggestion,
          availableActions: ["explain"],
        })),
      },
      actions({ explain }),
    );
    await hover(view, document.querySelector(".refine-suggestion"), 9);
    const card = document.querySelector<HTMLElement>(".refine-tooltip");
    const explainButton = card?.querySelector<HTMLButtonElement>("button");

    explainButton?.click();

    await vi.waitFor(() => expect(explainButton?.textContent).toBe("Explain"));
    expect(explainButton?.disabled).toBe(false);
    expect(
      card?.querySelector(".refine-tooltip__explanation-section .refine-tooltip__status")
        ?.textContent,
    ).toBe("No explanation available.");
    expect(document.querySelector(".refine-tooltip")).toBe(card);

    explainButton?.click();

    await vi.waitFor(() => expect(explain).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(explainButton?.isConnected).toBe(false));
    expect(document.querySelector(".refine-tooltip")).toBe(card);
  });

  it("terminates a never-ending explanation when its card is disposed", async () => {
    let nextCall = 0;
    let resolvePending: ((result: IteratorResult<ExplanationUpdate>) => void) | undefined;
    const returnIterator = vi.fn(
      async (): Promise<IteratorResult<ExplanationUpdate>> => ({
        done: true,
        value: undefined,
      }),
    );
    const iterator: AsyncIterableIterator<ExplanationUpdate> = {
      next: vi.fn((): Promise<IteratorResult<ExplanationUpdate>> => {
        nextCall += 1;
        if (nextCall === 1) {
          return Promise.resolve({
            done: false,
            value: {
              status: "started",
              attribution: {
                languageDisplayName: "English (American)",
                textDirection: "ltr",
                modelDisplayName: "On-Device (Gemma)",
              },
            },
          });
        }
        if (nextCall === 2) {
          return Promise.resolve({
            done: false,
            value: { status: "streaming", text: "Rendered line.\n" },
          });
        }
        return new Promise((resolve) => {
          resolvePending = resolve;
        });
      }),
      return: returnIterator,
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const cleanup = vi.fn();
    const renderExplanation = vi.fn((markdown: string, element: HTMLElement) => {
      element.textContent = markdown;
      return cleanup;
    });
    const { host, view } = createHost(
      "[create an link](URL)or",
      "explain-dispose",
      [],
      renderExplanation,
    );
    const baseSnapshot = presentation("explain-dispose:0");
    await host.present(
      {
        ...baseSnapshot,
        suggestions: baseSnapshot.suggestions.map((suggestion) => ({
          ...suggestion,
          availableActions: ["explain"],
        })),
      },
      actions({ explain: () => iterator }),
    );
    await hover(view, document.querySelector(".refine-suggestion"), 9);
    document.querySelector<HTMLButtonElement>(".refine-tooltip button")?.click();
    await vi.waitFor(() => expect(renderExplanation).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(iterator.next).toHaveBeenCalledTimes(3));

    await host.present(emptyPresentation("explain-dispose:0", 2), actions());

    expect(document.querySelector(".refine-tooltip")).toBeNull();
    expect(returnIterator).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();

    resolvePending?.({
      done: false,
      value: { status: "streaming", text: "Late detached update.\n" },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(renderExplanation).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("disposes a real runtime Explain stream without waiting for a server event", async () => {
    const { host, view } = createHost(
      "[create an link](URL)or",
      "runtime-explain-dispose",
    );
    const present = host.present.bind(host);
    const returnStates: { settled: boolean }[] = [];
    host.present = (snapshot, suggestionActions): void => {
      present(snapshot, {
        ...suggestionActions,
        explain: (suggestionId): AsyncIterable<ExplanationUpdate> => {
          const underlying = suggestionActions
            .explain(suggestionId)[Symbol.asyncIterator]();
          const instrumented: AsyncIterableIterator<ExplanationUpdate> = {
            next: () => underlying.next(),
            return: () => {
              const state = { settled: false };
              returnStates.push(state);
              const completion = underlying.return?.() ?? Promise.resolve({
                done: true as const,
                value: undefined,
              });
              void Promise.resolve(completion).then(
                () => {
                  state.settled = true;
                },
                () => {
                  state.settled = true;
                },
              );
              return completion;
            },
            [Symbol.asyncIterator]() {
              return this;
            },
          };
          return instrumented;
        },
      });
    };

    const events = new AsyncQueue<ServerEventEnvelope>();
    const commands: { command: ClientCommand; id: string }[] = [];
    let commandSequence = 0;
    let eventSequence = 0;
    const enginePort = {
      connect: async (): Promise<RefineTransportSession> => ({
        serverEpoch: "epoch-card",
        runResumed: false,
        send: async (command): Promise<CommandReceipt> => {
          commandSequence += 1;
          const id = `command-${commandSequence}`;
          commands.push({ command, id });
          return { sequence: commandSequence, id };
        },
        events: () => events,
        close: async () => events.close(),
      }),
    };
    const emit = (event: ServerEventEnvelope["event"]): void => {
      eventSequence += 1;
      events.push({
        type: "event",
        sequence: eventSequence,
        epoch: "epoch-card",
        event,
      });
    };
    const controller = new AbortController();
    const run = createRefineIntegration({ enginePort }).run({
      host,
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(commands[0]?.command.type).toBe("openDocument"),
    );
    const open = commands[0]?.command;
    if (!open || open.type !== "openDocument") {
      throw new Error("expected open document command");
    }
    emit({
      type: "presentationContentReplaced",
      checkId: "check-runtime-explain",
      content: {
        documentRevision: open.snapshot.revision,
        status: "complete",
        coverage: "full",
        appearance: DEFAULT_PRESENTATION_APPEARANCE,
        suggestions: [
          {
            id: "runtime-explain",
            sourceId: "document",
            kind: "grammar",
            attribution: testAttribution,
            highlightRanges: [{ location: 8, length: 2 }],
            diff: [],
            availableActions: ["explain"],
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(document.querySelector(".refine-suggestion")).not.toBeNull(),
    );
    const highlight = document.querySelector<HTMLElement>(".refine-suggestion");

    highlight?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    document.querySelector<HTMLButtonElement>(".refine-tooltip button")?.click();
    await vi.waitFor(() =>
      expect(
        commands.filter(({ command }) => command.type === "performAction"),
      ).toHaveLength(1),
    );

    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(document.querySelector(".refine-tooltip")).toBeNull();
    expect(returnStates).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(returnStates[0]?.settled).toBe(true);

    highlight?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    document.querySelector<HTMLButtonElement>(".refine-tooltip button")?.click();
    await vi.waitFor(() =>
      expect(
        commands.filter(({ command }) => command.type === "performAction"),
      ).toHaveLength(2),
    );

    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    controller.abort();
    await run;
  });

  it("labels a mixed suggestion as grammar and fluency", async () => {
    vi.useFakeTimers();
    try {
      const { host, view } = createHost("[create an link](URL)or", "mixed-label");
      const baseSnapshot = presentation("mixed-label:0");
      await host.present(
        {
          ...baseSnapshot,
          suggestions: baseSnapshot.suggestions.map((suggestion) => ({
            ...suggestion,
            kind: "mixed" as const,
          })),
        },
        actions(),
      );

      await hover(view, document.querySelector(".refine-suggestion"), 9);

      expect(document.querySelector(".refine-tooltip__caption")?.textContent).toBe(
        "Grammar & Fluency - English (American)",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports feedback without dismissing the suggestion card", async () => {
    const report = vi.fn(async () => ({ status: "completed" as const }));
    const { host, view } = createHost("[create an link](URL)or", "report");
    const baseSnapshot = presentation("report:0");
    const snapshot: PresentationSnapshot = {
      ...baseSnapshot,
      suggestions: baseSnapshot.suggestions.map((suggestion) => ({
        ...suggestion,
        availableActions: ["apply", "dismiss", "explain", "report"],
      })),
    };
    await host.present(snapshot, actions({ report }));
    await hover(view, document.querySelector(".refine-suggestion"), 9);
    const reportButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Report");

    reportButton?.click();

    await vi.waitFor(() => expect(report).toHaveBeenCalledWith("grammar-1"));
    expect(document.querySelector(".refine-tooltip")).not.toBeNull();
    expect(reportButton?.textContent).toBe("Reported");
    expect(document.querySelector(".refine-tooltip__feedback-status")?.textContent).toContain(
      "Thanks for the report.",
    );
  });

  it("keeps a failed Report card open and retries from the same action", async () => {
    let attempts = 0;
    const report = vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? { status: "unavailable" as const, reason: "reportingUnavailable" as const }
        : { status: "completed" as const };
    });
    const { host, view } = createHost("[create an link](URL)or", "report-retry");
    const baseSnapshot = presentation("report-retry:0");
    await host.present(
      {
        ...baseSnapshot,
        suggestions: baseSnapshot.suggestions.map((suggestion) => ({
          ...suggestion,
          availableActions: ["report"],
        })),
      },
      actions({ report }),
    );
    await hover(view, document.querySelector(".refine-suggestion"), 9);
    const card = document.querySelector<HTMLElement>(".refine-tooltip");
    const reportButton = card?.querySelector<HTMLButtonElement>("button");

    reportButton?.click();

    await vi.waitFor(() => expect(reportButton?.textContent).toBe("Retry report"));
    expect(document.querySelector(".refine-tooltip")).toBe(card);

    reportButton?.click();

    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
    expect(reportButton?.textContent).toBe("Reported");
    expect(document.querySelector(".refine-tooltip")).toBe(card);
  });

  it("shows a suggestion card after hovering without taking editor focus", async () => {
    vi.useFakeTimers();
    try {
      const { host, view } = createHost("[create an link](URL)or", "hover");
      await host.present(presentation("hover:0"), actions());
      view.focus();
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
      prepareHoverGeometry(view, 9);

      movePointer(highlight);
      expect(document.querySelector(".refine-tooltip")).toBeNull();
      await vi.advanceTimersByTimeAsync(99);
      expect(document.querySelector(".refine-tooltip")).toBeNull();
      await vi.advanceTimersByTimeAsync(1);

      expect(document.querySelector(".refine-tooltip")).not.toBeNull();
      expect(view.hasFocus).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the opening delay until the pointer rests on the suggestion", async () => {
    vi.useFakeTimers();
    try {
      const { host, view } = createHost("[create an link](URL)or", "hover-rest");
      await host.present(presentation("hover-rest:0"), actions());
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
      prepareHoverGeometry(view, 9);

      movePointer(highlight);
      await vi.advanceTimersByTimeAsync(75);
      movePointer(highlight);
      await vi.advanceTimersByTimeAsync(75);
      expect(document.querySelector(".refine-tooltip")).toBeNull();

      await vi.advanceTimersByTimeAsync(25);
      expect(document.querySelector(".refine-tooltip--hover")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers an above, right-aligned hover card when the viewport has room", async () => {
    vi.useFakeTimers();
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1000);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("refine-tooltip") ? 320 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("refine-tooltip") ? 100 : 0;
    });
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("cm-scroller")) {
        return new DOMRect(0, 0, 1000, 800);
      }
      if (
        this.classList.contains("refine-tooltip")
      ) {
        return new DOMRect(0, 0, 320, 100);
      }
      return originalBounds.call(this);
    });
    try {
      const { host, view } = createHost(
        "[create an link](URL)or",
        "preferred-hover-position",
      );
      await host.present(presentation("preferred-hover-position:0"), actions());
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
      vi.spyOn(view, "inView", "get").mockReturnValue(true);
      vi.spyOn(view, "posAtCoords").mockReturnValue(9);
      const coordinates = vi.spyOn(view, "coordsAtPos").mockImplementation(
        (position) => position === 10
          ? { left: 496, right: 500, top: 500, bottom: 520 }
          : { left: 296, right: 300, top: 500, bottom: 520 },
      );

      highlight?.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 298,
          clientY: 510,
        }),
      );
      await vi.advanceTimersByTimeAsync(320);

      const card = document.querySelector<HTMLElement>(
        ".refine-tooltip--hover",
      );
      expect({
        placement: card?.dataset.refinePlacement,
        left: card?.style.left,
        top: card?.style.top,
      }).toEqual({
        placement: "top-end",
        left: "180px",
        top: "396px",
      });
      expect(coordinates).toHaveBeenCalledWith(10, -1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a space-only diff while making it visible and accessible", async () => {
    vi.useFakeTimers();
    try {
      const { host, view } = createHost("[create an link](URL)or", "space-diff");
      await host.present(spaceOnlyPresentation("space-diff:0"), actions());
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");

      await hover(view, highlight, 21);

      const card = document.querySelector<HTMLElement>(".refine-tooltip");
      const insertion = document.querySelector<HTMLElement>(".refine-tooltip__insert");
      expect(document.querySelector(".refine-tooltip__diff")?.textContent).toBe(
        "link or",
      );
      expect(insertion?.textContent).toBe(" ");
      expect(insertion?.getAttribute("aria-label")).toBe("Inserted space");
      expect(insertion?.dataset.refineWhitespaceMarker).toBe("·");
      expect(card?.style.getPropertyValue("--refine-addition-color")).toBe("#34C759");
      expect(card?.style.getPropertyValue("--refine-deletion-color")).toBe("#FF3B30");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a deleted space without drawing a hidden-whitespace marker when disabled", async () => {
    const { host, view } = createHost("[create an link](URL)or", "space-delete");
    await host.present(
      spaceOnlyPresentation("space-delete:0", "delete", false),
      actions(),
    );
    const highlight = document.querySelector<HTMLElement>(".refine-suggestion");

    await hover(view, highlight, 21);

    const deletion = document.querySelector<HTMLElement>(".refine-tooltip__delete");
    expect(deletion?.textContent).toBe(" ");
    expect(deletion?.getAttribute("aria-label")).toBe("Deleted space");
    expect(deletion?.hasAttribute("data-refine-whitespace-marker")).toBe(false);
  });

  it("keeps an inserted space literal inside a multi-run diff", async () => {
    vi.useFakeTimers();
    try {
      const { host, view } = createHost("[create an link](URL)or", "mixed-diff");
      await host.present(presentation("mixed-diff:0"), actions());
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");

      await hover(view, highlight, 9);

      const insertedParts = document.querySelectorAll<HTMLElement>(
        ".refine-tooltip__insert",
      );
      expect([...insertedParts].map((part) => part.textContent)).toEqual(["a", " "]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("portals a hover card without CodeMirror's tooltip shell", async () => {
    vi.useFakeTimers();
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve(import.meta.dirname, "../../styles.css"), "utf8");
    document.head.append(style);
    try {
      const { host, view } = createHost("[create an link](URL)or", "rounded-shell");
      await host.present(spaceOnlyPresentation("rounded-shell:0"), actions());
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");

      await hover(view, highlight, 21);

      const card = document.querySelector<HTMLElement>(".refine-tooltip--hover");
      expect(card).not.toBeNull();
      expect(card?.parentElement).toBe(document.body);
      expect(card?.closest(".cm-tooltip")).toBeNull();
    } finally {
      style.remove();
      vi.useRealTimers();
    }
  });

  it("gives hover cards a readable responsive width and wraps long content", async () => {
    vi.useFakeTimers();
    const style = document.createElement("style");
    style.textContent = readFileSync(
      resolve(import.meta.dirname, "../../styles.css"),
      "utf8",
    );
    document.head.append(style);
    try {
      const { host, view } = createHost("[create an link](URL)or", "responsive-card");
      view.dom.parentElement?.classList.add("view-content");
      view.dom.parentElement?.style.setProperty("overflow", "hidden");
      const snapshot = presentation("responsive-card:0");
      const longToken = "unbroken".repeat(40);
      await host.present(
        {
          ...snapshot,
          suggestions: snapshot.suggestions.map((suggestion) => ({
            ...suggestion,
            diff: [{ kind: "insert" as const, text: longToken }],
          })),
        },
        actions(),
      );
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");

      await hover(view, highlight, 9);

      const card = document.querySelector<HTMLElement>(".refine-tooltip");
      const diff = document.querySelector<HTMLElement>(".refine-tooltip__diff");
      const cardStyle = getComputedStyle(card!);
      const tooltipRule = Array.from(style.sheet?.cssRules ?? []).find(
        (rule) =>
          "selectorText" in rule &&
          (rule as CSSStyleRule).selectorText === ".refine-tooltip",
      ) as CSSStyleRule | undefined;
      expect(cardStyle.boxSizing).toBe("border-box");
      expect(cardStyle.inlineSize).toBe("max-content");
      expect(cardStyle.minInlineSize).toBe("320px");
      expect(cardStyle.maxInlineSize).toBe("448px");
      expect(view.dom.parentElement?.style.overflow).toBe("hidden");
      expect(card?.closest(".cm-editor")).toBeNull();
      expect(card?.parentElement).toBe(document.body);
      expect(tooltipRule?.style.minInlineSize).toMatch(/min\(20rem,.*100vw/);
      expect(tooltipRule?.style.minInlineSize).toContain("-2rem");
      expect(tooltipRule?.style.maxInlineSize).toMatch(/min\(28rem,.*100vw/);
      expect(tooltipRule?.style.maxInlineSize).toContain("-2rem");
      expect(diff?.textContent).toBe(longToken);
      expect(getComputedStyle(diff!).overflowWrap).toBe("anywhere");
    } finally {
      style.remove();
      vi.useRealTimers();
    }
  });

  it.each(["underline", "dashedUnderline", "highlight"] as const)(
    "renders %s highlights and insertion anchors with kind colors",
    async (style) => {
      const { host } = createHost("abcdef", `appearance-${style}`);
      await host.present(appearancePresentation(`appearance-${style}:0`, style), actions());

      const grammar = document.querySelector<HTMLElement>(
        '[data-refine-suggestion-id="grammar-style"]',
      );
      const fluency = document.querySelector<HTMLElement>(
        '[data-refine-suggestion-id="fluency-style"]',
      );
      const mixed = document.querySelector<HTMLElement>(
        '[data-refine-suggestion-id="mixed-style"]',
      );
      expect(grammar?.classList.contains(`refine-suggestion--${style}`)).toBe(true);
      expect(grammar?.style.getPropertyValue("--refine-suggestion-color")).toBe("#AABBCC");
      expect(fluency?.classList.contains(`refine-suggestion--${style}`)).toBe(true);
      expect(fluency?.style.getPropertyValue("--refine-suggestion-color")).toBe("#DDEEFF");
      expect(mixed?.classList.contains(`refine-insertion-anchor--${style}`)).toBe(true);
      expect(mixed?.style.getPropertyValue("--refine-suggestion-color")).toBe("#DDEEFF");
    },
  );

  it.each([
    ["underline", "solid"],
    ["dashedUnderline", "dashed"],
  ] as const)(
    "keeps the Refine %s color and style when Live Preview owns the text color",
    async (highlightStyle, decorationStyle) => {
      const style = document.createElement("style");
      style.textContent = `${readFileSync(
        resolve(import.meta.dirname, "../../styles.css"),
        "utf8",
      )}
        .cm-editor .cm-content .cm-underline {
          color: rgb(118, 74, 188);
          text-decoration-line: underline;
          text-decoration-color: currentColor;
          text-decoration-style: solid;
        }
      `;
      document.head.append(style);
      try {
        const livePreviewLink = Decoration.mark({ class: "cm-underline" }).range(0, 6);
        const { host } = createHost("abcdef", "live-preview-underline-color", [
          EditorView.decorations.of(Decoration.set([livePreviewLink])),
        ]);
        await host.present(
          appearancePresentation("live-preview-underline-color:0", highlightStyle),
          actions(),
        );
        const grammar = document.querySelector<HTMLElement>(
          '[data-refine-suggestion-id="grammar-style"]',
        );
        const livePreviewText = grammar?.querySelector<HTMLElement>(".cm-underline");

        const livePreviewComputed = getComputedStyle(livePreviewText!);
        const refineComputed = getComputedStyle(grammar!);
        expect(livePreviewComputed.color).toBe("rgb(118, 74, 188)");
        expect(livePreviewComputed.textDecorationLine).toBe("none");
        // The custom property remains available to highlight mode while the
        // inline longhand makes the underline authoritative over host and theme CSS.
        expect(refineComputed.getPropertyValue("--refine-suggestion-color")).toBe("#AABBCC");
        expect(refineComputed.textDecorationColor).toBe("rgb(170, 187, 204)");
        expect(refineComputed.textDecorationStyle).toBe(decorationStyle);
      } finally {
        style.remove();
      }
    },
  );

  it("keeps the Refine underline color authoritative on plain editor text", async () => {
    const style = document.createElement("style");
    style.textContent = `${readFileSync(
      resolve(import.meta.dirname, "../../styles.css"),
      "utf8",
    )}
      .cm-editor .cm-content .refine-suggestion {
        color: rgb(42, 42, 42);
        text-decoration-color: currentColor;
      }
    `;
    document.head.append(style);
    try {
      const { host } = createHost("abcdef", "plain-underline-color");
      await host.present(
        appearancePresentation("plain-underline-color:0", "underline"),
        actions(),
      );
      const grammar = document.querySelector<HTMLElement>(
        '[data-refine-suggestion-id="grammar-style"]',
      );
      const computed = getComputedStyle(grammar!);

      expect(computed.color).toBe("rgb(42, 42, 42)");
      expect(computed.getPropertyValue("--refine-suggestion-color")).toBe("#AABBCC");
      expect(computed.textDecorationColor).toBe("rgb(170, 187, 204)");
    } finally {
      style.remove();
    }
  });

  it("suppresses native spellcheck paint without disabling spellcheck", async () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(
      resolve(import.meta.dirname, "../../styles.css"),
      "utf8",
    );
    document.head.append(style);
    const { host, view } = createHost("abcdef", "spellcheck-underline");
    try {
      view.contentDOM.spellcheck = true;
      await host.present(
        appearancePresentation("spellcheck-underline:0", "underline"),
        actions(),
      );
      const grammar = document.querySelector<HTMLElement>(
        '[data-refine-suggestion-id="grammar-style"]',
      );
      const spellingRule = Array.from(style.sheet?.cssRules ?? []).find(
        (rule) =>
          "selectorText" in rule &&
          (rule as CSSStyleRule).selectorText.includes("::spelling-error"),
      ) as CSSStyleRule | undefined;

      expect(view.contentDOM.spellcheck).toBe(true);
      expect(grammar?.getAttribute("spellcheck")).toBeNull();
      expect(spellingRule?.selectorText).toContain(
        ":is(.refine-suggestion, .refine-suggestion *)::spelling-error",
      );
      expect(spellingRule?.selectorText).toContain(
        ":is(.refine-suggestion, .refine-suggestion *)::grammar-error",
      );
      expect(spellingRule?.style.textDecorationLine).toBe("none");
    } finally {
      style.remove();
    }
  });

  it("preserves Live Preview's link underline when Refine uses highlight style", async () => {
    const style = document.createElement("style");
    style.textContent = `${readFileSync(
      resolve(import.meta.dirname, "../../styles.css"),
      "utf8",
    )}
      .cm-editor .cm-content .cm-underline {
        color: rgb(118, 74, 188);
        text-decoration-line: underline;
        text-decoration-color: currentColor;
        text-decoration-style: solid;
      }
    `;
    document.head.append(style);
    try {
      const livePreviewLink = Decoration.mark({ class: "cm-underline" }).range(0, 6);
      const { host } = createHost("abcdef", "live-preview-highlight", [
        EditorView.decorations.of(Decoration.set([livePreviewLink])),
      ]);
      await host.present(
        appearancePresentation("live-preview-highlight:0", "highlight"),
        actions(),
      );
      const grammar = document.querySelector<HTMLElement>(
        '[data-refine-suggestion-id="grammar-style"]',
      );
      const livePreviewText = grammar?.querySelector<HTMLElement>(".cm-underline");
      const computed = getComputedStyle(livePreviewText!);

      expect(grammar?.classList.contains("refine-suggestion--highlight")).toBe(true);
      expect(computed.color).toBe("rgb(118, 74, 188)");
      expect(computed.textDecorationLine).toBe("underline");
      expect(computed.textDecorationColor).toBe("rgb(118, 74, 188)");
    } finally {
      style.remove();
    }
  });

  it("chooses overlapping hover content by fragment length, grammar kind, then stable ID", async () => {
    const { host, view } = createHost("abcdef", "overlap");
    await host.present(overlapPresentation("overlap:0"), actions());
    const target = document.querySelector<HTMLElement>(".refine-suggestion");

    await hover(view, target, 3);

    expect(document.querySelector(".refine-tooltip__diff")?.textContent).toBe(
      "grammar-a",
    );
  });

  it("does not infer a suggestion scope from separated highlight fragments", async () => {
    const { host, view } = createHost("abcdef", "split-overlap");
    await host.present(splitScopeOverlapPresentation("split-overlap:0"), actions());
    const target = document.querySelector<HTMLElement>(
      '[data-refine-suggestion-id="paragraph"]',
    );

    await hover(view, target, 3);

    expect(document.querySelector(".refine-tooltip__diff")?.textContent).toBe(
      "paragraph",
    );
  });

  it("uses separated marks as entrances to one sentence-scoped suggestion", async () => {
    const { host, view } = createHost(
      "I update the plugin and reruh Refine.",
      "sentence-separated-marks",
    );
    const snapshot = sentenceScopedPresentation("sentence-separated-marks:0");
    const apply = vi.fn(async () => ({ status: "completed" as const }));
    const suggestionActions = actions({ apply });
    await host.present(snapshot, suggestionActions);

    const marks = document.querySelectorAll<HTMLElement>(
      '[data-refine-suggestion-id="sentence-correction"]',
    );
    expect(marks).toHaveLength(2);

    await hover(view, marks[0] ?? null, 4);
    const firstDiff = document.querySelector(".refine-tooltip__diff")?.innerHTML;
    expect(
      [...document.querySelectorAll<HTMLElement>(".refine-tooltip__delete")]
        .map((part) => part.textContent),
    ).toEqual(["update", "reruh"]);
    expect(
      [...document.querySelectorAll<HTMLElement>(".refine-tooltip__insert")]
        .map((part) => part.textContent),
    ).toEqual(["updated", "reran"]);

    // Replacing the presentation closes the first card without changing the
    // semantic suggestion, letting the second correction act as another
    // entrance to the same contextual diff and Apply group.
    await host.present(snapshot, suggestionActions);
    const replacementMarks = document.querySelectorAll<HTMLElement>(
      '[data-refine-suggestion-id="sentence-correction"]',
    );
    await hover(view, replacementMarks[1] ?? null, 26);
    expect(document.querySelector(".refine-tooltip__diff")?.innerHTML).toBe(firstDiff);

    document.querySelector<HTMLButtonElement>(".refine-tooltip button")?.click();
    await vi.waitFor(() => {
      expect(apply).toHaveBeenCalledOnce();
      expect(apply).toHaveBeenCalledWith("sentence-correction");
    });
  });

  it("names the suggestion dialog without Obsidian's tooltip-triggering aria-label", async () => {
    vi.useFakeTimers();
    try {
      const { host, view } = createHost("[create an link](URL)or", "dialog-name");
      await host.present(presentation("dialog-name:0"), actions());
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
      await hover(view, highlight, 9);
      const card = document.querySelector<HTMLElement>(".refine-tooltip");
      const labelId = card?.getAttribute("aria-labelledby");

      expect(card?.getAttribute("role")).toBe("dialog");
      expect(card?.hasAttribute("aria-label")).toBe(false);
      expect(card?.style.getPropertyValue("--no-tooltip")).toBe("true");
      expect(labelId).toBeTruthy();
      expect(document.getElementById(labelId ?? "")?.textContent).toBe(
        "Refine writing suggestion",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps trigger labels accessible without requesting Obsidian tooltips", async () => {
    const { host } = createHost("[create an link](URL)or", "trigger-name");
    await host.present(presentation("trigger-name:0"), actions());
    const triggers = document.querySelectorAll<HTMLElement>(
      ".refine-suggestion, .refine-insertion-anchor",
    );

    expect(triggers).toHaveLength(2);
    for (const trigger of triggers) {
      expect(trigger.getAttribute("aria-label")).toMatch(/^Refine .+ suggestion$/);
      expect(trigger.style.getPropertyValue("--no-tooltip")).toBe("true");
    }
  });

  it("dismisses a hover card with Escape", async () => {
    vi.useFakeTimers();
    try {
      const { host, view } = createHost("[create an link](URL)or", "hover-escape");
      await host.present(presentation("hover-escape:0"), actions());
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
      await hover(view, highlight, 9);
      expect(document.querySelector(".refine-tooltip")).not.toBeNull();

      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      view.contentDOM.dispatchEvent(escape);

      expect(escape.defaultPrevented).toBe(true);
      expect(document.querySelector(".refine-tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the hover card open while moving onto its actions", async () => {
    vi.useFakeTimers();
    try {
      const { host, view } = createHost("[create an link](URL)or", "hover-actions");
      await host.present(presentation("hover-actions:0"), actions());
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
      await hover(view, highlight, 9);
      const card = document.querySelector<HTMLElement>(".refine-tooltip");
      expect(card).not.toBeNull();

      document.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      card?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      vi.runAllTimers();
      expect(document.querySelector(".refine-tooltip")).toBe(card);

    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the card open through the pointer bridge and closes after moving away", async () => {
    vi.useFakeTimers();
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("refine-tooltip")) {
        return new DOMRect(-20, 60, 320, 100);
      }
      return originalBounds.call(this);
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("refine-tooltip") ? 320 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("refine-tooltip") ? 100 : 0;
    });
    try {
      const { host, view } = createHost("[create an link](URL)or", "hover-bridge");
      await host.present(presentation("hover-bridge:0"), actions());
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
      vi.spyOn(view, "posAtCoords").mockReturnValue(9);
      vi.spyOn(view, "coordsAtPos").mockReturnValue({
        left: 296,
        right: 300,
        top: 200,
        bottom: 220,
      });
      highlight?.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 298,
          clientY: 210,
        }),
      );
      await vi.advanceTimersByTimeAsync(220);
      const card = document.querySelector<HTMLElement>(".refine-tooltip--hover");
      expect(card).not.toBeNull();

      view.contentDOM.dispatchEvent(
        new MouseEvent("mouseleave", {
          clientX: 298,
          clientY: 200,
          relatedTarget: document.body,
        }),
      );
      await vi.advanceTimersByTimeAsync(80);
      document.body.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 280,
          clientY: 180,
        }),
      );
      await vi.advanceTimersByTimeAsync(80);
      expect(document.querySelector(".refine-tooltip")).toBe(card);

      card?.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 280,
          clientY: 120,
        }),
      );
      await vi.advanceTimersByTimeAsync(200);
      expect(document.querySelector(".refine-tooltip")).toBe(card);

      card?.dispatchEvent(
        new MouseEvent("mouseleave", {
          clientX: 280,
          clientY: 160,
          relatedTarget: document.body,
        }),
      );
      document.body.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 800,
          clientY: 700,
        }),
      );
      await vi.advanceTimersByTimeAsync(120);
      expect(document.querySelector(".refine-tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a hover card open while focus is inside its actions", async () => {
    vi.useFakeTimers();
    try {
      const { host, view } = createHost("[create an link](URL)or", "hover-focus");
      await host.present(presentation("hover-focus:0"), actions());
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
      await hover(view, highlight, 9);
      const card = document.querySelector<HTMLElement>(".refine-tooltip--hover");
      const button = card?.querySelector<HTMLButtonElement>("button");
      button?.focus();

      view.contentDOM.dispatchEvent(
        new MouseEvent("mouseleave", {
          clientX: 10,
          clientY: 10,
          relatedTarget: document.body,
        }),
      );
      await vi.advanceTimersByTimeAsync(500);
      expect(document.querySelector(".refine-tooltip")).toBe(card);

      view.focus();
      await vi.advanceTimersByTimeAsync(120);
      expect(document.querySelector(".refine-tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not show stale hover content after a presentation replacement", async () => {
    vi.useFakeTimers();
    try {
      const { host, view } = createHost("[create an link](URL)or", "hover-stale");
      await host.present(presentation("hover-stale:0"), actions());
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
      prepareHoverGeometry(view, 9);
      movePointer(highlight);

      await host.present(emptyPresentation("hover-stale:0", 2), actions());
      await vi.advanceTimersByTimeAsync(220);
      expect(document.querySelector(".refine-tooltip")).toBeNull();

      await host.present(
        { ...presentation("hover-stale:0"), presentationRevision: 3 },
        actions(),
      );
      const replacement = document.querySelector<HTMLElement>(".refine-suggestion");
      movePointer(replacement);
      await vi.advanceTimersByTimeAsync(220);
      expect(document.querySelector(".refine-tooltip")).not.toBeNull();

      await host.present(emptyPresentation("hover-stale:0", 4), actions());
      expect(document.querySelector(".refine-tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hovers by source position when Live Preview syntax is the event target", async () => {
    const livePreviewSyntax = Decoration.widget({
      side: 1,
      widget: new LivePreviewSyntaxWidget(),
    }).range(9);
    const { host, view } = createHost(
      "[create an link](URL)or",
      "live-preview-pointer",
      [EditorView.decorations.of(Decoration.set([livePreviewSyntax]))],
    );
    await host.present(presentation("live-preview-pointer:0"), actions());
    const syntaxTarget = document.querySelector<HTMLElement>(".cm-underline");
    expect(syntaxTarget?.dataset.refineSuggestionId).toBeUndefined();

    // The hover source resolves from the authoritative CodeMirror position,
    // so Live Preview DOM does not need Refine metadata of its own.
    await hover(view, syntaxTarget, 9);

    expect(document.querySelector(".refine-tooltip")).not.toBeNull();
  });

  it("leaves physical clicks to the editor instead of opening the card", async () => {
    const { host, view } = createHost("[create an link](URL)or", "pointer-click");
    await host.present(presentation("pointer-click:0"), actions());
    const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
    expect(highlight).not.toBeNull();
    await hover(view, highlight, 9);
    expect(document.querySelector(".refine-tooltip")).not.toBeNull();
    const pointerDownWasPrevented = capturePointerDownBeforeCodeMirror(view);

    const pointerDown = new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    });
    highlight?.dispatchEvent(pointerDown);
    expect(pointerDownWasPrevented()).toBe(false);
    expect(document.querySelector(".refine-tooltip")).toBeNull();
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));

    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
      clientX: 10,
      clientY: 10,
    });
    highlight?.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(false);
    expect(document.querySelector(".refine-tooltip")).toBeNull();
  });

  it("does not turn a quick physical click into a delayed hover card", async () => {
    vi.useFakeTimers();
    try {
      const { host, view } = createHost("[create an link](URL)or", "quick-click");
      await host.present(presentation("quick-click:0"), actions());
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
      prepareHoverGeometry(view, 9);
      movePointer(highlight);
      await vi.advanceTimersByTimeAsync(100);
      capturePointerDownBeforeCodeMirror(view);

      highlight?.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      );
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
      highlight?.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          detail: 1,
          clientX: 10,
          clientY: 10,
        }),
      );
      await vi.advanceTimersByTimeAsync(120);

      expect(document.querySelector(".refine-tooltip")).toBeNull();

      movePointer(highlight);
      await vi.advanceTimersByTimeAsync(200);
      expect(document.querySelector(".refine-tooltip")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reopen hover when results arrive during a pointer gesture", async () => {
    vi.useFakeTimers();
    try {
      const { host, view } = createHost("[create an link](URL)or", "gesture-results");
      await host.present(presentation("gesture-results:0"), actions());
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
      prepareHoverGeometry(view, 9);
      movePointer(highlight);
      await vi.advanceTimersByTimeAsync(100);
      capturePointerDownBeforeCodeMirror(view);
      highlight?.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      );

      await host.present(
        { ...presentation("gesture-results:0"), presentationRevision: 2 },
        actions(),
      );
      await vi.advanceTimersByTimeAsync(120);

      expect(document.querySelector(".refine-tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves zero-detail click activation for assistive technology", async () => {
    const { host } = createHost("[create an link](URL)or", "assistive-click");
    await host.present(presentation("assistive-click:0"), actions());
    const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 0,
    });

    highlight?.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(document.querySelector(".refine-tooltip button")).not.toBeNull();
  });

  it("leaves drag selection across an underlined suggestion untouched", async () => {
    const { host, view } = createHost("[create an link](URL)or", "pointer-drag");
    await host.present(presentation("pointer-drag:0"), actions());
    const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
    expect(highlight).not.toBeNull();
    const pointerDownWasPrevented = capturePointerDownBeforeCodeMirror(view);

    const pointerDown = new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    });
    highlight?.dispatchEvent(pointerDown);
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    highlight?.dispatchEvent(dragStart);
    document.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        buttons: 1,
        clientX: 30,
        clientY: 10,
      }),
    );
    view.dispatch({ selection: { anchor: 8, head: 10 } });
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
      clientX: 30,
      clientY: 10,
    });
    highlight?.dispatchEvent(click);

    expect(pointerDownWasPrevented()).toBe(false);
    expect(dragStart.defaultPrevented).toBe(false);
    expect(click.defaultPrevented).toBe(false);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "an",
    );
    expect(document.querySelector(".refine-tooltip")).toBeNull();
  });

  it("does not show the hover card during a slow drag selection", async () => {
    vi.useFakeTimers();
    try {
      const { host, view } = createHost("[create an link](URL)or", "slow-pointer-drag");
      await host.present(presentation("slow-pointer-drag:0"), actions());
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
      prepareHoverGeometry(view, 9);
      capturePointerDownBeforeCodeMirror(view);
      highlight?.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          clientX: 10,
          clientY: 10,
        }),
      );
      highlight?.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          buttons: 1,
          clientX: 12,
          clientY: 10,
        }),
      );

      await vi.advanceTimersByTimeAsync(220);

      expect(document.querySelector(".refine-tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hover while a slow drag crosses a suggestion from ordinary text", async () => {
    vi.useFakeTimers();
    try {
      const { host, view } = createHost("[create an link](URL)or", "cross-range-drag");
      await host.present(presentation("cross-range-drag:0"), actions());
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
      const position = vi.spyOn(view, "posAtCoords");
      position.mockReturnValueOnce(0).mockReturnValue(9);
      vi.spyOn(view, "coordsAtPos").mockReturnValue({
        left: 8,
        right: 12,
        top: 8,
        bottom: 20,
      });
      capturePointerDownBeforeCodeMirror(view);

      view.contentDOM.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          cancelable: true,
          clientX: 2,
          clientY: 10,
        }),
      );
      highlight?.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          buttons: 1,
          clientX: 10,
          clientY: 10,
        }),
      );
      await vi.advanceTimersByTimeAsync(220);

      expect(document.querySelector(".refine-tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels Live Preview link dragging while leaving text selection available", async () => {
    const { host, view } = createHost("[create an link](URL)or", "link-pointer-drag");
    await host.present(presentation("link-pointer-drag:0"), actions());
    vi.spyOn(view, "posAtCoords").mockReturnValue(9);
    const link = document.querySelector<HTMLElement>(".refine-suggestion");
    expect(link).not.toBeNull();
    link?.classList.add("cm-link", "cm-underline");
    if (!link) {
      return;
    }
    link.draggable = true;
    const pointerDownWasPrevented = capturePointerDownBeforeCodeMirror(view);

    link.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      }),
    );
    const liveLink = document.querySelector<HTMLElement>(".refine-suggestion");
    expect(liveLink).not.toBeNull();
    if (!liveLink) {
      return;
    }
    liveLink.draggable = true;
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    liveLink.dispatchEvent(dragStart);
    view.dispatch({ selection: { anchor: 8, head: 10 } });

    expect(pointerDownWasPrevented()).toBe(false);
    expect(dragStart.defaultPrevented).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "an",
    );
    expect(document.querySelector(".refine-tooltip")).toBeNull();
  });

  it("shows the card when hovering a zero-width insertion suggestion anchor", async () => {
    const { host, view } = createHost("[create an link](URL)or", "insertion-pointer");
    await host.present(presentation("insertion-pointer:0"), actions());
    const anchor = document.querySelector<HTMLElement>(".refine-insertion-anchor");
    expect(anchor).not.toBeNull();
    await hover(view, anchor, 21);

    expect(document.querySelector(".refine-tooltip")).not.toBeNull();
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

  it("prefers an above, right-aligned keyboard card and clamps viewport fallbacks", async () => {
    let viewportWidth = 960;
    let viewportHeight = 600;
    let cardWidth = 320;
    let cardHeight = 200;
    let triggerLeft = 500;
    let triggerTop = 400;
    let resizeObserverCallback: ResizeObserverCallback | undefined;
    const previousResizeObserver = Object.getOwnPropertyDescriptor(window, "ResizeObserver");
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeObserverCallback = callback;
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
    });
    vi.spyOn(document.documentElement, "clientWidth", "get").mockImplementation(
      () => viewportWidth,
    );
    vi.spyOn(document.documentElement, "clientHeight", "get").mockImplementation(
      () => viewportHeight,
    );
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("refine-tooltip") ? cardWidth : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("refine-tooltip") ? cardHeight : 0;
    });
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("refine-suggestion")) {
        return new DOMRect(triggerLeft, triggerTop, 40, 20);
      }
      if (this.classList.contains("refine-tooltip--manual")) {
        return new DOMRect(
          Number.parseFloat(this.style.left) || 0,
          Number.parseFloat(this.style.top) || 0,
          cardWidth,
          cardHeight,
        );
      }
      return originalBounds.call(this);
    });
    try {
      const { host } = createHost("[create an link](URL)or", "keyboard-right-edge");
      await host.present(presentation("keyboard-right-edge:0"), actions());
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");

      highlight?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      const card = document.querySelector<HTMLElement>(".refine-tooltip--manual");
      await vi.waitFor(() => {
        expect(card?.style.left).toBe("220px");
        expect(card?.style.top).toBe("196px");
      });

      triggerTop = 100;
      resizeObserverCallback?.([], {} as ResizeObserver);
      await vi.waitFor(() => expect(card?.style.top).toBe("124px"));

      triggerLeft = 920;
      resizeObserverCallback?.([], {} as ResizeObserver);
      await vi.waitFor(() => expect(card?.style.left).toBe("624px"));

      cardWidth = 448;
      resizeObserverCallback?.([], {} as ResizeObserver);
      await vi.waitFor(() => expect(card?.style.left).toBe("496px"));

      cardWidth = 320;
      viewportWidth = 400;
      window.dispatchEvent(new Event("resize"));
      await vi.waitFor(() => expect(card?.style.left).toBe("64px"));

      triggerTop = 560;
      viewportHeight = 600;
      cardHeight = 200;
      resizeObserverCallback?.([], {} as ResizeObserver);
      await vi.waitFor(() => expect(card?.style.top).toBe("356px"));
    } finally {
      if (previousResizeObserver) {
        Object.defineProperty(window, "ResizeObserver", previousResizeObserver);
      } else {
        Reflect.deleteProperty(window, "ResizeObserver");
      }
    }
  });

  it("dismisses a keyboard-opened card with Escape and restores its trigger", async () => {
    const { host } = createHost("[create an link](URL)or", "keyboard-escape");
    await host.present(presentation("keyboard-escape:0"), actions());
    const highlight = document.querySelector<HTMLElement>(".refine-suggestion");
    highlight?.focus();
    highlight?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const button = document.querySelector<HTMLButtonElement>(".refine-tooltip button");
    expect(document.activeElement).toBe(button);

    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    button?.dispatchEvent(escape);

    expect(escape.defaultPrevented).toBe(true);
    expect(document.querySelector(".refine-tooltip")).toBeNull();
    expect(document.activeElement).toBe(highlight);
  });

  it("does not add a hover card beside a keyboard-opened suggestion card", async () => {
    vi.useFakeTimers();
    try {
      const { host, view } = createHost("[create an link](URL)or", "keyboard-hover");
      await host.present(presentation("keyboard-hover:0"), actions());
      const highlight = document.querySelector<HTMLElement>(".refine-suggestion");

      highlight?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(document.querySelectorAll(".refine-tooltip")).toHaveLength(1);

      prepareHoverGeometry(view, 9);
      movePointer(highlight);
      await vi.advanceTimersByTimeAsync(220);

      expect(document.querySelectorAll(".refine-tooltip")).toHaveLength(1);
      expect(document.querySelector(".refine-tooltip--manual")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  function createHost(
    doc: string,
    sessionId: string,
    extensions: Extension[] = [],
    renderExplanation?: (
      markdown: string,
      element: HTMLElement,
    ) => void | (() => void),
  ): {
    host: ObsidianWritingHost;
    view: EditorView;
  } {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions }),
    });
    const host = new ObsidianWritingHost(view, {
      sessionId,
      ...(renderExplanation === undefined ? {} : { renderExplanation }),
    });
    hosts.push(host);
    views.push(view);
    return { host, view };
  }
});

class LivePreviewSyntaxWidget extends WidgetType {
  toDOM(view: EditorView): HTMLElement {
    const syntax = view.dom.ownerDocument.createElement("span");
    syntax.className = "cm-underline";
    syntax.textContent = "syntax";
    return syntax;
  }
}

function presentation(revision: string): PresentationSnapshot {
  return {
    documentRevision: revision,
    presentationRevision: 1,
    appearance: DEFAULT_PRESENTATION_APPEARANCE,
    state: { type: "complete", coverage: "full" },
    suggestions: [
      {
        id: "grammar-1",
        sourceId: "document",
        kind: "grammar",
        attribution: testAttribution,
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

function separatedSuggestionPresentation(
  revision: string,
  locationOffset = 0,
): PresentationSnapshot {
  return {
    documentRevision: revision,
    presentationRevision: 1,
    appearance: DEFAULT_PRESENTATION_APPEARANCE,
    state: { type: "complete", coverage: "full" },
    suggestions: [
      {
        id: "first",
        sourceId: "document",
        kind: "grammar",
        attribution: testAttribution,
        highlightRanges: [{ location: locationOffset, length: 3 }],
        diff: [{ kind: "delete", text: "bad" }],
        availableActions: ["apply"],
      },
      {
        id: "second",
        sourceId: "document",
        kind: "grammar",
        attribution: testAttribution,
        highlightRanges: [
          { location: locationOffset + 11, length: 3 },
          { location: locationOffset + 21, length: 0 },
        ],
        diff: [{ kind: "delete", text: "bad" }],
        availableActions: ["apply"],
      },
    ],
  };
}

function lifecyclePresentation(
  documentRevision: string,
  presentationRevision: number,
  state: PresentationSnapshot["state"],
): PresentationSnapshot {
  return {
    documentRevision,
    presentationRevision,
    appearance: DEFAULT_PRESENTATION_APPEARANCE,
    state,
    suggestions: [],
  };
}

function spaceOnlyPresentation(
  revision: string,
  kind: "insert" | "delete" = "insert",
  showHiddenWhitespace = true,
): PresentationSnapshot {
  return {
    documentRevision: revision,
    presentationRevision: 1,
    appearance: {
      ...DEFAULT_PRESENTATION_APPEARANCE,
      diff: {
        ...DEFAULT_PRESENTATION_APPEARANCE.diff,
        showHiddenWhitespace,
      },
    },
    state: { type: "complete", coverage: "full" },
    suggestions: [
      {
        id: "suggestion-space",
        sourceId: "document",
        kind: "grammar",
        attribution: testAttribution,
        highlightRanges: [
          { location: 21, length: 1 },
        ],
        diff: [
          { kind: "unchanged", text: "link" },
          { kind, text: " " },
          { kind: "unchanged", text: "or" },
        ],
        availableActions: ["apply", "dismiss"],
      },
    ],
  };
}

function emptyPresentation(
  documentRevision: string,
  presentationRevision: number,
): PresentationSnapshot {
  return {
    documentRevision,
    presentationRevision,
    appearance: DEFAULT_PRESENTATION_APPEARANCE,
    state: { type: "complete", coverage: "full" },
    suggestions: [],
  };
}

function appearancePresentation(
  revision: string,
  style: PresentationSnapshot["appearance"]["highlight"]["style"],
): PresentationSnapshot {
  return {
    documentRevision: revision,
    presentationRevision: 1,
    appearance: {
      highlight: {
        style,
        grammarColor: "#AABBCC",
        fluencyColor: "#DDEEFF",
      },
      diff: DEFAULT_PRESENTATION_APPEARANCE.diff,
    },
    state: { type: "complete", coverage: "full" },
    suggestions: [
      {
        id: "grammar-style",
        sourceId: "document",
        kind: "grammar",
        attribution: testAttribution,
        highlightRanges: [{ location: 0, length: 2 }],
        diff: [],
        availableActions: [],
      },
      {
        id: "fluency-style",
        sourceId: "document",
        kind: "fluency",
        attribution: testAttribution,
        highlightRanges: [{ location: 3, length: 2 }],
        diff: [],
        availableActions: [],
      },
      {
        id: "mixed-style",
        sourceId: "document",
        kind: "mixed",
        attribution: testAttribution,
        highlightRanges: [{ location: 6, length: 0 }],
        diff: [],
        availableActions: [],
      },
    ],
  };
}

function overlapPresentation(revision: string): PresentationSnapshot {
  const candidate = (
    id: string,
    kind: "grammar" | "fluency",
    location: number,
    length: number,
  ) => ({
    id,
    sourceId: "document" as const,
    kind,
    attribution: testAttribution,
    highlightRanges: [{ location, length }],
    diff: [{ kind: "unchanged" as const, text: id }],
    availableActions: [] as const,
  });
  return {
    documentRevision: revision,
    presentationRevision: 1,
    appearance: DEFAULT_PRESENTATION_APPEARANCE,
    state: { type: "complete", coverage: "full" },
    suggestions: [
      candidate("grammar-wide", "grammar", 0, 6),
      candidate("fluency-a", "fluency", 2, 2),
      candidate("grammar-z", "grammar", 2, 2),
      candidate("grammar-a", "grammar", 2, 2),
    ],
  };
}

function splitScopeOverlapPresentation(revision: string): PresentationSnapshot {
  return {
    documentRevision: revision,
    presentationRevision: 1,
    appearance: DEFAULT_PRESENTATION_APPEARANCE,
    state: { type: "complete", coverage: "full" },
    suggestions: [
      {
        id: "paragraph",
        sourceId: "document",
        kind: "grammar",
        attribution: testAttribution,
        highlightRanges: [
          { location: 0, length: 1 },
          { location: 2, length: 2 },
          { location: 5, length: 1 },
        ],
        diff: [{ kind: "unchanged", text: "paragraph" }],
        availableActions: [],
      },
      {
        id: "word",
        sourceId: "document",
        kind: "fluency",
        attribution: testAttribution,
        highlightRanges: [{ location: 2, length: 3 }],
        diff: [{ kind: "unchanged", text: "word" }],
        availableActions: [],
      },
    ],
  };
}

function sentenceScopedPresentation(revision: string): PresentationSnapshot {
  return {
    documentRevision: revision,
    presentationRevision: 1,
    appearance: DEFAULT_PRESENTATION_APPEARANCE,
    state: { type: "complete", coverage: "full" },
    suggestions: [
      {
        id: "sentence-correction",
        sourceId: "document",
        kind: "fluency",
        attribution: testAttribution,
        highlightRanges: [
          { location: 2, length: 6 },
          { location: 24, length: 5 },
        ],
        diff: [
          { kind: "unchanged", text: "I " },
          { kind: "delete", text: "update" },
          { kind: "insert", text: "updated" },
          { kind: "unchanged", text: " the plugin and " },
          { kind: "delete", text: "reruh" },
          { kind: "insert", text: "reran" },
          { kind: "unchanged", text: " Refine." },
        ],
        availableActions: ["apply"],
      },
    ],
  };
}

const testAttribution = {
  languageDisplayName: "English (American)",
  textDirection: "ltr" as const,
  checkModelDisplayName: "On-Device (Gemma 4 E4B)",
};

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

async function hover(
  view: EditorView,
  target: HTMLElement | null,
  position: number,
): Promise<void> {
  const usingFakeTimers = vi.isFakeTimers();
  prepareHoverGeometry(view, position);
  movePointer(target);
  if (usingFakeTimers) {
    await vi.advanceTimersByTimeAsync(220);
  } else {
    await new Promise((resolve) => setTimeout(resolve, 220));
  }
}

function prepareHoverGeometry(view: EditorView, position: number): void {
  vi.spyOn(view, "posAtCoords").mockReturnValue(position);
  vi.spyOn(view, "coordsAtPos").mockReturnValue({
    left: 8,
    right: 12,
    top: 8,
    bottom: 20,
  });
}

function movePointer(target: HTMLElement | null): void {
  target?.dispatchEvent(
    new MouseEvent("mousemove", {
      bubbles: true,
      clientX: 10,
      clientY: 10,
    }),
  );
}

function capturePointerDownBeforeCodeMirror(
  view: EditorView,
  stopBeforeCodeMirror = true,
): () => boolean | undefined {
  let defaultPrevented: boolean | undefined;
  view.contentDOM.addEventListener(
    "mousedown",
    (event) => {
      defaultPrevented = event.defaultPrevented;
      // jsdom does not implement the geometry methods CodeMirror's native
      // selection handler needs. Stop after Refine's capture listener; the
      // assertion still proves Refine left the gesture available to CodeMirror.
      if (stopBeforeCodeMirror) {
        event.stopImmediatePropagation();
      }
    },
    { capture: true, once: true },
  );
  return () => defaultPrevented;
}
