// @vitest-environment jsdom

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ExplanationUpdate,
  PresentedSuggestion,
  PresentationInteraction,
  PresentationSnapshot,
  SuggestionActions,
} from "../../src/integration/types";
import {
  DEFAULT_PRESENTATION_APPEARANCE,
  DEFAULT_PRESENTATION_INTERACTION,
} from "../../src/integration/types";
import { ObsidianWritingHost } from "../../src/obsidian/host";

if (typeof Range.prototype.getClientRects !== "function") {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
}
if (typeof Range.prototype.getBoundingClientRect !== "function") {
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}

describe("Obsidian suggestion Apply shortcuts", () => {
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

  it("applies the opaque action from the full activation scope before editor keymaps", () => {
    let fallbackTabs = 0;
    const fallback = EditorView.domEventHandlers({
      keydown(event) {
        if (event.key !== "Tab") {
          return false;
        }
        fallbackTabs += 1;
        return true;
      },
    });
    const { host, view } = createHost("A sentence with a correction.", [fallback]);
    view.dispatch({ selection: { anchor: 3 }, userEvent: "select" });
    const apply = vi.fn(async () => ({ status: "completed" as const }));
    host.present(
      snapshot({
        suggestions: [
          suggestion({
            activationRange: { location: 0, length: 29 },
            highlightRanges: [{ location: 16, length: 10 }],
          }),
        ],
      }),
      actions({ apply }),
    );

    expect(document.querySelector(".refine-suggestion--quick-apply-active"))
      .not.toBeNull();
    expect(document.querySelector(".refine-quick-apply-tip")?.textContent)
      .toBe("Press Tab to apply");
    const beforeSelection = view.state.selection;
    const event = keydown("Tab", "Tab");
    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(fallbackTabs).toBe(0);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith("suggestion");
    expect(view.state.doc.toString()).toBe("A sentence with a correction.");
    expect(view.state.selection.eq(beforeSelection)).toBe(true);
    expect(document.querySelector(".refine-suggestion--quick-apply-active"))
      .toBeNull();
  });

  it("switches the active shortcut and tip when Refine settings change", () => {
    const { host, view } = createHost("A sentence.");
    view.dispatch({ selection: { anchor: 4 }, userEvent: "select" });
    const apply = vi.fn(async () => ({ status: "completed" as const }));
    const base = snapshot({
      suggestions: [suggestion({ activationRange: { location: 0, length: 11 } })],
    });
    host.present(base, actions({ apply }));

    host.present(
      {
        ...base,
        presentationRevision: 2,
        interaction: interaction({ applyKey: "rightShift" }),
      },
      actions({ apply }),
    );

    expect(document.querySelector(".refine-quick-apply-tip")?.textContent)
      .toBe("Press Right Shift to apply");
    const oldKey = keydown("Tab", "Tab");
    view.contentDOM.dispatchEvent(oldKey);
    expect(oldKey.defaultPrevented).toBe(false);
    expect(apply).not.toHaveBeenCalled();

    const newKey = keydown("Shift", "ShiftRight", { shiftKey: true });
    view.contentDOM.dispatchEvent(newKey);
    expect(newKey.defaultPrevented).toBe(true);
    expect(apply).toHaveBeenCalledWith("suggestion");
  });

  it("uses the synchronized dismiss key only to cancel cursor activation", () => {
    const { host, view } = createHost("A sentence.");
    view.dispatch({ selection: { anchor: 4 }, userEvent: "select" });
    const apply = vi.fn(async () => ({ status: "completed" as const }));
    const dismiss = vi.fn(async () => ({ status: "completed" as const }));
    host.present(
      snapshot({
        suggestions: [suggestion({ activationRange: { location: 0, length: 11 } })],
      }),
      actions({ apply, dismiss }),
    );

    const escape = keydown("Escape", "Escape");
    view.contentDOM.dispatchEvent(escape);

    expect(escape.defaultPrevented).toBe(true);
    expect(dismiss).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(document.querySelector(".refine-suggestion--quick-apply-active"))
      .toBeNull();
    expect(document.querySelector(".refine-quick-apply-tip")).toBeNull();

    const tab = keydown("Tab", "Tab");
    view.contentDOM.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("leaves keyboard-open behavior to a focused suggestion mark", () => {
    const { host, view } = createHost("A sentence.");
    view.dispatch({ selection: { anchor: 4 }, userEvent: "select" });
    const apply = vi.fn(async () => ({ status: "completed" as const }));
    host.present(
      snapshot({
        interaction: interaction({ applyKey: "return" }),
        suggestions: [suggestion({ activationRange: { location: 0, length: 11 } })],
      }),
      actions({ apply }),
    );
    const mark = document.querySelector<HTMLElement>(".refine-suggestion");
    mark?.focus();

    const enter = keydown("Enter", "Enter");
    mark?.dispatchEvent(enter);

    expect(apply).not.toHaveBeenCalled();
    expect(document.querySelector(".refine-tooltip--manual")).not.toBeNull();
  });

  it("keeps an active insertion anchor durable through keyboard open and Escape", async () => {
    const { host, view } = createHost("abc");
    view.dispatch({ selection: { anchor: 1 }, userEvent: "select" });
    vi.spyOn(view, "coordsAtPos").mockReturnValue({
      left: 48,
      right: 48,
      top: 12,
      bottom: 28,
    });
    host.present(
      snapshot({
        suggestions: [suggestion({
          activationRange: { location: 1, length: 0 },
          highlightRanges: [{ location: 1, length: 0 }],
        })],
      }),
      actions(),
    );
    const original = document.querySelector<HTMLElement>(
      ".refine-insertion-anchor",
    );
    let detachedMeasurements = 0;
    vi.spyOn(original!, "getBoundingClientRect").mockImplementation(() => {
      if (!original?.isConnected) {
        detachedMeasurements += 1;
      }
      return new DOMRect(48, 12, 0, 16);
    });
    original?.focus();

    original?.dispatchEvent(keydown("Enter", "Enter"));

    const button = document.querySelector<HTMLButtonElement>(
      ".refine-tooltip--manual button",
    );
    expect(document.activeElement).toBe(button);
    await vi.waitFor(() => expect(
      document.querySelector<HTMLElement>(".refine-tooltip--manual")?.style.visibility,
    ).toBe(""));
    expect(detachedMeasurements).toBe(0);

    button?.dispatchEvent(keydown("Escape", "Escape"));

    const replacement = document.querySelector<HTMLElement>(
      ".refine-insertion-anchor",
    );
    expect(document.querySelector(".refine-tooltip")).toBeNull();
    expect(
      document.activeElement === replacement || view.hasFocus,
    ).toBe(true);
  });

  it("fails closed when a keyboard-open insertion card has no text geometry", async () => {
    const { host, view } = createHost("abc");
    view.dispatch({ selection: { anchor: 1 }, userEvent: "select" });
    host.present(
      snapshot({
        suggestions: [suggestion({
          activationRange: { location: 1, length: 0 },
          highlightRanges: [{ location: 1, length: 0 }],
        })],
      }),
      actions(),
    );
    const anchor = document.querySelector<HTMLElement>(
      ".refine-insertion-anchor--quick-apply-active",
    );
    anchor?.focus();
    const coordinates = vi.spyOn(view, "coordsAtPos").mockImplementation(() => {
      throw new RangeError("text geometry is no longer available");
    });

    anchor?.dispatchEvent(keydown("Enter", "Enter"));

    const card = document.querySelector<HTMLElement>(
      ".refine-tooltip--manual",
    );
    await vi.waitFor(() => expect(card?.style.visibility).toBe(""));
    expect(coordinates).toHaveBeenCalled();
  });

  it("does not capture a configured key from another focused editor control", () => {
    const { host, view } = createHost("A sentence.");
    view.dispatch({ selection: { anchor: 4 }, userEvent: "select" });
    const apply = vi.fn(async () => ({ status: "completed" as const }));
    host.present(
      snapshot({
        interaction: interaction({ applyKey: "return" }),
        suggestions: [suggestion({ activationRange: { location: 0, length: 11 } })],
      }),
      actions({ apply }),
    );
    const link = document.createElement("a");
    link.href = "#destination";
    link.textContent = "Open destination";
    view.contentDOM.append(link);
    link.focus();

    const enter = keydown("Enter", "Enter");
    link.dispatchEvent(enter);

    expect(enter.defaultPrevented).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    link.remove();
  });

  it("applies a visible hover card from the editor with cursor activation disabled", async () => {
    vi.useFakeTimers();
    try {
      const { host, view } = createHost("A sentence.");
      const apply = vi.fn(async () => ({ status: "completed" as const }));
      host.present(
        snapshot({
          interaction: interaction({ enabled: false, applyKey: "tab" }),
          suggestions: [suggestion({
            activationRange: { location: 5, length: 5 },
            highlightRanges: [{ location: 2, length: 2 }],
          })],
        }),
        actions({ apply }),
      );
      vi.spyOn(view, "posAtCoords").mockReturnValue(3);
      vi.spyOn(view, "coordsAtPos").mockReturnValue({
        left: 8,
        right: 12,
        top: 8,
        bottom: 20,
      });
      document.querySelector<HTMLElement>(".refine-suggestion")?.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 10,
          clientY: 10,
        }),
      );
      await vi.advanceTimersByTimeAsync(220);
      expect(document.querySelector(".refine-tooltip--hover")).not.toBeNull();

      const before = view.state.doc.toString();
      const tab = keydown("Tab", "Tab");
      view.contentDOM.dispatchEvent(tab);

      expect(tab.defaultPrevented).toBe(true);
      expect(apply).toHaveBeenCalledOnce();
      expect(apply).toHaveBeenCalledWith("suggestion");
      expect(view.state.doc.toString()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a portaled card's configured Apply key precedence over its focused action", () => {
    const { host } = createHost("A sentence.");
    const apply = vi.fn(async () => ({ status: "completed" as const }));
    const dismiss = vi.fn(async () => ({ status: "completed" as const }));
    host.present(
      snapshot({
        interaction: interaction({ enabled: false, applyKey: "return" }),
        suggestions: [suggestion({
          availableActions: ["dismiss", "apply"],
        })],
      }),
      actions({ apply, dismiss }),
    );
    document.querySelector<HTMLElement>(".refine-suggestion")?.dispatchEvent(
      keydown("Enter", "Enter"),
    );
    const dismissButton = document.querySelector<HTMLButtonElement>(
      '[data-refine-action="dismiss"]',
    );
    dismissButton?.focus();

    const enter = keydown("Enter", "Enter");
    dismissButton?.dispatchEvent(enter);

    expect(enter.defaultPrevented).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith("suggestion");
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("consumes a second card shortcut while one Apply is pending without duplicating it", () => {
    const { host } = createHost("A sentence.");
    let finishApply: ((outcome: { readonly status: "completed" }) => void) |
      undefined;
    const apply = vi.fn(() =>
      new Promise<{ readonly status: "completed" }>((resolve) => {
        finishApply = resolve;
      })
    );
    host.present(
      snapshot({
        interaction: interaction({ enabled: false, applyKey: "rightShift" }),
        suggestions: [suggestion()],
      }),
      actions({ apply }),
    );
    document.querySelector<HTMLElement>(".refine-suggestion")?.dispatchEvent(
      keydown("Enter", "Enter"),
    );
    const applyButton = document.querySelector<HTMLButtonElement>(
      '[data-refine-action="apply"]',
    );

    const first = keydown("Shift", "ShiftRight", { shiftKey: true });
    applyButton?.dispatchEvent(first);
    const second = keydown("Shift", "ShiftRight", { shiftKey: true });
    applyButton?.dispatchEvent(second);

    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    finishApply?.({ status: "completed" });
  });

  it("lets a card's configured Escape apply before the generic close shortcut", () => {
    const { host } = createHost("A sentence.");
    let finishApply: ((outcome: { readonly status: "completed" }) => void) |
      undefined;
    const apply = vi.fn(() =>
      new Promise<{ readonly status: "completed" }>((resolve) => {
        finishApply = resolve;
      })
    );
    host.present(
      snapshot({
        interaction: interaction({ enabled: false, applyKey: "escape" }),
        suggestions: [suggestion()],
      }),
      actions({ apply }),
    );
    document.querySelector<HTMLElement>(".refine-suggestion")?.dispatchEvent(
      keydown("Enter", "Enter"),
    );
    const applyButton = document.querySelector<HTMLButtonElement>(
      '[data-refine-action="apply"]',
    );

    const escape = keydown("Escape", "Escape");
    applyButton?.dispatchEvent(escape);

    expect(escape.defaultPrevented).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    expect(document.querySelector(".refine-tooltip--manual")).not.toBeNull();
    expect(applyButton?.getAttribute("aria-busy")).toBe("true");
    finishApply?.({ status: "completed" });
  });

  it("uses the latest synchronized card key and rebound Apply action", () => {
    const { host } = createHost("A sentence.");
    const oldApply = vi.fn(async () => ({ status: "completed" as const }));
    const newApply = vi.fn(async () => ({ status: "completed" as const }));
    const first = snapshot({
      interaction: interaction({ enabled: false, applyKey: "tab" }),
      suggestions: [suggestion()],
    });
    host.present(first, actions({ apply: oldApply }));
    document.querySelector<HTMLElement>(".refine-suggestion")?.dispatchEvent(
      keydown("Enter", "Enter"),
    );

    host.present(
      {
        ...first,
        presentationRevision: 2,
        interaction: interaction({ enabled: false, applyKey: "rightShift" }),
      },
      actions({ apply: newApply }),
    );
    const applyButton = document.querySelector<HTMLButtonElement>(
      '[data-refine-action="apply"]',
    );
    const oldKey = keydown("Tab", "Tab");
    applyButton?.dispatchEvent(oldKey);
    const newKey = keydown("Shift", "ShiftRight", { shiftKey: true });
    applyButton?.dispatchEvent(newKey);

    expect(oldKey.defaultPrevented).toBe(false);
    expect(newKey.defaultPrevented).toBe(true);
    expect(oldApply).not.toHaveBeenCalled();
    expect(newApply).toHaveBeenCalledOnce();
  });

  it("leaves the configured card key native when the visible suggestion has no Apply", () => {
    const { host } = createHost("A sentence.");
    const apply = vi.fn(async () => ({ status: "completed" as const }));
    host.present(
      snapshot({
        interaction: interaction({ enabled: false, applyKey: "tab" }),
        suggestions: [suggestion({ availableActions: ["dismiss"] })],
      }),
      actions({ apply }),
    );
    document.querySelector<HTMLElement>(".refine-suggestion")?.dispatchEvent(
      keydown("Enter", "Enter"),
    );
    const dismissButton = document.querySelector<HTMLButtonElement>(
      '[data-refine-action="dismiss"]',
    );

    const tab = keydown("Tab", "Tab");
    dismissButton?.dispatchEvent(tab);

    expect(tab.defaultPrevented).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("does not fall through from a no-Apply card to another cursor suggestion", () => {
    const { host, view } = createHost("0123456789");
    const apply = vi.fn(async () => ({ status: "completed" as const }));
    host.present(
      snapshot({
        suggestions: [
          suggestion({
            id: "card-only-dismiss",
            activationRange: { location: 0, length: 1 },
            highlightRanges: [{ location: 0, length: 1 }],
            availableActions: ["dismiss"],
          }),
          suggestion({
            id: "cursor-apply",
            activationRange: { location: 5, length: 2 },
            highlightRanges: [{ location: 5, length: 1 }],
          }),
        ],
      }),
      actions({ apply }),
    );
    document.querySelector<HTMLElement>(
      '[data-refine-suggestion-id="card-only-dismiss"]',
    )?.dispatchEvent(keydown("Enter", "Enter"));
    view.dispatch({ selection: { anchor: 6 }, userEvent: "select" });
    expect(document.querySelector(".refine-tooltip--manual")).not.toBeNull();
    expect(document.querySelector(
      '[data-refine-suggestion-id="cursor-apply"]' +
      ".refine-suggestion--quick-apply-active",
    )).not.toBeNull();

    const tab = keydown("Tab", "Tab");
    view.contentDOM.dispatchEvent(tab);

    expect(tab.defaultPrevented).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("lets an open card own its key from a focused editor descendant", async () => {
    vi.useFakeTimers();
    try {
      const { host, view } = createHost("A sentence.");
      const apply = vi.fn(async () => ({ status: "completed" as const }));
      host.present(
        snapshot({
          interaction: interaction({ enabled: false, applyKey: "return" }),
          suggestions: [suggestion({
            highlightRanges: [{ location: 2, length: 2 }],
          })],
        }),
        actions({ apply }),
      );
      vi.spyOn(view, "posAtCoords").mockReturnValue(3);
      vi.spyOn(view, "coordsAtPos").mockReturnValue({
        left: 8,
        right: 12,
        top: 8,
        bottom: 20,
      });
      document.querySelector<HTMLElement>(".refine-suggestion")?.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 10,
          clientY: 10,
        }),
      );
      await vi.advanceTimersByTimeAsync(220);
      const link = document.createElement("a");
      link.href = "#destination";
      view.contentDOM.append(link);
      link.focus();

      const enter = keydown("Enter", "Enter");
      link.dispatchEvent(enter);

      expect(enter.defaultPrevented).toBe(true);
      expect(apply).toHaveBeenCalledOnce();
      link.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a decoy Apply marker outside the card's owned action row", () => {
    const { host } = createHost("A sentence.");
    const apply = vi.fn(async () => ({ status: "completed" as const }));
    host.present(
      snapshot({ suggestions: [suggestion()] }),
      actions({ apply }),
    );
    document.querySelector<HTMLElement>(".refine-suggestion")?.dispatchEvent(
      keydown("Enter", "Enter"),
    );
    const card = document.querySelector<HTMLElement>(".refine-tooltip--manual");
    const decoy = document.createElement("button");
    decoy.dataset.refineAction = "apply";
    const decoyClick = vi.fn();
    decoy.addEventListener("click", decoyClick);
    card?.prepend(decoy);
    const realApply = card?.querySelector<HTMLButtonElement>(
      ".refine-tooltip__actions > button[data-refine-action=apply]",
    );

    realApply?.dispatchEvent(keydown("Tab", "Tab"));

    expect(decoyClick).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledOnce();
  });

  it("keeps focusable suggestion labels free of editor-surface shortcut claims", () => {
    const { host, view } = createHost("abc");
    host.present(
      snapshot({
        suggestions: [
          suggestion({
            id: "replacement",
            activationRange: { location: 0, length: 1 },
            highlightRanges: [{ location: 0, length: 1 }],
          }),
          suggestion({
            id: "insertion",
            activationRange: { location: 3, length: 0 },
            highlightRanges: [{ location: 3, length: 0 }],
          }),
        ],
      }),
      actions(),
    );

    const mark = document.querySelector<HTMLElement>(
      '[data-refine-suggestion-id="replacement"]',
    );
    expect(mark?.classList).toContain("refine-suggestion--quick-apply-active");
    expect(mark?.getAttribute("aria-label")).toBe("Refine writing suggestion");

    view.dispatch({ selection: { anchor: 3 }, userEvent: "select" });
    const anchor = document.querySelector<HTMLElement>(
      '[data-refine-suggestion-id="insertion"]',
    );
    expect(anchor?.classList).toContain(
      "refine-insertion-anchor--quick-apply-active",
    );
    expect(anchor?.getAttribute("aria-label")).toBe(
      "Refine insertion suggestion",
    );
  });

  it("suppresses pointer selections and reactivates after keyboard caret movement", () => {
    const { host, view } = createHost("A sentence.");
    const apply = vi.fn(async () => ({ status: "completed" as const }));
    host.present(
      snapshot({
        suggestions: [suggestion({ activationRange: { location: 2, length: 6 } })],
      }),
      actions({ apply }),
    );

    view.dispatch({ selection: { anchor: 4 }, userEvent: "select.pointer" });
    expect(document.querySelector(".refine-suggestion--quick-apply-active"))
      .toBeNull();
    const pointerTab = keydown("Tab", "Tab");
    view.contentDOM.dispatchEvent(pointerTab);
    expect(pointerTab.defaultPrevented).toBe(false);

    view.dispatch({ selection: { anchor: 0 }, userEvent: "select" });
    view.dispatch({ selection: { anchor: 4 }, userEvent: "select" });
    expect(document.querySelector(".refine-suggestion--quick-apply-active"))
      .not.toBeNull();
    const keyboardTab = keydown("Tab", "Tab");
    view.contentDOM.dispatchEvent(keyboardTab);
    expect(keyboardTab.defaultPrevented).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
  });

  it("does not let a later progressive suggestion steal first-visible activation", () => {
    const { host, view } = createHost("A sentence with overlap.");
    view.dispatch({ selection: { anchor: 6 }, userEvent: "select" });
    const apply = vi.fn(async () => ({ status: "completed" as const }));
    const wide = suggestion({
      id: "wide",
      activationRange: { location: 0, length: 23 },
      highlightRanges: [{ location: 2, length: 2 }],
    });
    const first = snapshot({ suggestions: [wide], state: { type: "checking" } });
    host.present(first, actions({ apply }));

    const narrow = suggestion({
      id: "narrow",
      activationRange: { location: 5, length: 3 },
      highlightRanges: [{ location: 10, length: 2 }],
    });
    host.present(
      { ...first, presentationRevision: 2, suggestions: [wide, narrow] },
      actions({ apply }),
    );

    expect(
      document.querySelector(
        "[data-refine-suggestion-id=wide].refine-suggestion--quick-apply-active",
      ),
    ).not.toBeNull();
    expect(
      document.querySelector(
        "[data-refine-suggestion-id=narrow].refine-suggestion--quick-apply-active",
      ),
    ).toBeNull();
    view.contentDOM.dispatchEvent(keydown("Tab", "Tab"));
    expect(apply).toHaveBeenCalledWith("wide");
  });

  it("disarms an empty first-visible latch when another suggestion is hovered", () => {
    const { host, view } = createHost("A sentence.");
    const apply = vi.fn(async () => ({ status: "completed" as const }));
    const hovered = suggestion({
      id: "hovered",
      activationRange: { location: 5, length: 5 },
      highlightRanges: [{ location: 5, length: 3 }],
    });
    const first = snapshot({
      state: { type: "checking" },
      suggestions: [hovered],
    });
    host.present(first, actions({ apply }));
    expect(document.querySelector(".refine-suggestion--quick-apply-active"))
      .toBeNull();

    vi.spyOn(view, "posAtCoords").mockReturnValue(6);
    vi.spyOn(view, "coordsAtPos").mockReturnValue({
      left: 8,
      right: 12,
      top: 8,
      bottom: 20,
    });
    document.querySelector<HTMLElement>(
      '[data-refine-suggestion-id="hovered"]',
    )?.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      clientX: 10,
      clientY: 10,
    }));

    host.present(
      {
        ...first,
        presentationRevision: 2,
        suggestions: [
          hovered,
          suggestion({
            id: "later-at-caret",
            activationRange: { location: 0, length: 1 },
            highlightRanges: [{ location: 0, length: 1 }],
          }),
        ],
      },
      actions({ apply }),
    );

    expect(document.querySelector(".refine-suggestion--quick-apply-active"))
      .toBeNull();
    const tab = keydown("Tab", "Tab");
    view.contentDOM.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("resets first-visible activation only for a new check generation", () => {
    const { host, view } = createHost("A sentence.");
    view.dispatch({ selection: { anchor: 4 }, userEvent: "select" });
    const candidate = suggestion({ activationRange: { location: 0, length: 11 } });
    const first = snapshot({ suggestions: [candidate] });
    host.present(first, actions());
    view.contentDOM.dispatchEvent(keydown("Escape", "Escape"));
    expect(document.querySelector(".refine-suggestion--quick-apply-active"))
      .toBeNull();

    host.present(
      {
        ...first,
        presentationRevision: 2,
        interaction: interaction({ applyKey: "rightShift" }),
      },
      actions(),
    );
    expect(document.querySelector(".refine-suggestion--quick-apply-active"))
      .toBeNull();
    host.present(
      {
        ...first,
        presentationRevision: 3,
        state: { type: "checking" },
        suggestions: [
          candidate,
          suggestion({
            id: "later-progressive",
            activationRange: { location: 2, length: 3 },
          }),
        ],
      },
      actions(),
    );
    expect(document.querySelector(".refine-suggestion--quick-apply-active"))
      .toBeNull();

    host.present(
      {
        ...first,
        checkGeneration: 2,
        presentationRevision: 4,
        state: { type: "checking" },
      },
      actions(),
    );

    expect(document.querySelector(".refine-suggestion--quick-apply-active"))
      .not.toBeNull();
  });

  it("keeps settings disablement disarmed until a new generation or caret move", () => {
    const { host, view } = createHost("A sentence.");
    view.dispatch({ selection: { anchor: 4 }, userEvent: "select" });
    const candidate = suggestion({ activationRange: { location: 0, length: 11 } });
    const first = snapshot({ suggestions: [candidate] });
    host.present(first, actions());
    expect(document.querySelector(".refine-suggestion--quick-apply-active"))
      .not.toBeNull();

    host.present(
      {
        ...first,
        presentationRevision: 2,
        interaction: interaction({ enabled: false }),
      },
      actions(),
    );
    host.present(
      {
        ...first,
        presentationRevision: 3,
        interaction: interaction({ applyKey: "rightShift" }),
      },
      actions(),
    );
    expect(document.querySelector(".refine-suggestion--quick-apply-active"))
      .toBeNull();

    view.dispatch({ selection: { anchor: 5 }, userEvent: "select" });
    expect(document.querySelector(".refine-suggestion--quick-apply-active"))
      .not.toBeNull();
  });

  it("arms a later progressive candidate after an explicit empty caret move", () => {
    const { host, view } = createHost("A sentence.");
    const first = snapshot({ state: { type: "checking" } });
    host.present(first, actions());

    view.dispatch({ selection: { anchor: 4 }, userEvent: "select" });
    host.present(
      {
        ...first,
        presentationRevision: 2,
        suggestions: [suggestion({ activationRange: { location: 0, length: 11 } })],
      },
      actions(),
    );

    expect(document.querySelector(".refine-suggestion--quick-apply-active"))
      .not.toBeNull();
  });

  it("honors disabled and highlight-only activation settings", () => {
    const { host, view } = createHost("A sentence.");
    view.dispatch({ selection: { anchor: 4 }, userEvent: "select" });
    const suggestionAtCursor = suggestion({
      activationRange: { location: 0, length: 11 },
    });
    host.present(
      snapshot({
        interaction: interaction({ activationStyle: "highlightChanges" }),
        suggestions: [suggestionAtCursor],
      }),
      actions(),
    );
    expect(document.querySelector(".refine-suggestion--quick-apply-active"))
      .not.toBeNull();
    expect(document.querySelector(".refine-quick-apply-tip")).toBeNull();

    host.present(
      snapshot({
        presentationRevision: 2,
        interaction: interaction({ enabled: false }),
        suggestions: [suggestionAtCursor],
      }),
      actions(),
    );
    expect(document.querySelector(".refine-suggestion--quick-apply-active"))
      .toBeNull();
    const tab = keydown("Tab", "Tab");
    view.contentDOM.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });

  function createHost(
    doc: string,
    extensions: Extension[] = [],
  ): { host: ObsidianWritingHost; view: EditorView } {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions }),
    });
    const host = new ObsidianWritingHost(view, { sessionId: "quick-apply" });
    hosts.push(host);
    views.push(view);
    return { host, view };
  }
});

function snapshot(
  overrides: Partial<PresentationSnapshot> = {},
): PresentationSnapshot {
  return {
    documentRevision: "quick-apply:0",
    checkGeneration: 1,
    presentationRevision: 1,
    appearance: DEFAULT_PRESENTATION_APPEARANCE,
    interaction: DEFAULT_PRESENTATION_INTERACTION,
    state: { type: "complete", coverage: "full" },
    suggestions: [],
    ...overrides,
  };
}

function interaction(
  overrides: Partial<PresentationInteraction["quickApply"]> = {},
): PresentationInteraction {
  return {
    automaticChecksEnabled:
      DEFAULT_PRESENTATION_INTERACTION.automaticChecksEnabled,
    quickApply: {
      ...DEFAULT_PRESENTATION_INTERACTION.quickApply,
      ...overrides,
    },
  };
}

function suggestion(
  overrides: Partial<PresentedSuggestion> = {},
): PresentedSuggestion {
  return {
    id: "suggestion",
    sourceId: "document",
    kind: "grammar",
    attribution: {
      languageDisplayName: "English (American)",
      textDirection: "ltr",
      checkModelDisplayName: "On-Device (Gemma)",
    },
    activationRange: { location: 0, length: 1 },
    highlightRanges: [{ location: 2, length: 2 }],
    diff: [
      { kind: "delete", text: "is" },
      { kind: "insert", text: "was" },
    ],
    availableActions: ["apply"],
    ...overrides,
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

function keydown(
  key: string,
  code: string,
  overrides: KeyboardEventInit = {},
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    code,
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
}
