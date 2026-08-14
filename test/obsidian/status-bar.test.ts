// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type { PresentationSnapshot } from "../../src/integration/types";
import { DEFAULT_PRESENTATION_APPEARANCE } from "../../src/integration/types";
import type { ObsidianSessionState } from "../../src/obsidian/session-manager";
import {
  createRefineStatusBarController,
  statusBarStateForSession,
} from "../../src/obsidian/status-bar";

describe("Refine status bar", () => {
  it("starts in an accessible no-editor state", () => {
    const element = document.createElement("div");
    const renderIcon = vi.fn((target: HTMLElement, icon: string) => {
      target.dataset.icon = icon;
    });

    createRefineStatusBarController({
      element,
      renderIcon,
      onActivate: vi.fn(),
    });

    expect(element).toMatchObject({
      role: "button",
      tabIndex: 0,
      title: "Refine: No editable Markdown note. Open Refine menu",
    });
    expect(element.classList.contains("refine-status-bar")).toBe(true);
    expect(element.getAttribute("aria-label")).toBe(
      "Refine: No editable Markdown note. Open Refine menu",
    );
    expect(element.getAttribute("aria-live")).toBe("polite");
    expect(element.dataset.refineState).toBe("noEditor");
    expect(renderIcon).toHaveBeenCalledWith(element, "spell-check-2");
  });

  it("preserves the native Obsidian status item class", () => {
    const element = document.createElement("div");
    element.classList.add("status-bar-item");

    createRefineStatusBarController({
      element,
      renderIcon: vi.fn(),
      onActivate: vi.fn(),
    });

    expect([...element.classList]).toEqual(["status-bar-item", "refine-status-bar"]);
  });

  it("communicates when Refine is idle and ready", () => {
    const element = document.createElement("div");
    const renderIcon = vi.fn();
    const controller = createRefineStatusBarController({
      element,
      renderIcon,
      onActivate: vi.fn(),
    });

    controller.setState({ type: "idle" });

    const label = "Refine: Ready. Open Refine menu";
    expect(element.dataset.refineState).toBe("idle");
    expect(element.title).toBe(label);
    expect(element.getAttribute("aria-label")).toBe(label);
    expect(element.hasAttribute("aria-busy")).toBe(false);
    expect(renderIcon).toHaveBeenLastCalledWith(element, "spell-check-2");
  });

  it("returns to no-editor status when the editable note closes", () => {
    const element = document.createElement("div");
    const controller = createRefineStatusBarController({
      element,
      renderIcon: vi.fn(),
      onActivate: vi.fn(),
    });
    controller.setState({ type: "idle" });

    controller.setState({ type: "noEditor" });

    expect(element.dataset.refineState).toBe("noEditor");
    expect(element.getAttribute("aria-label")).toBe(
      "Refine: No editable Markdown note. Open Refine menu",
    );
  });

  it("communicates an in-progress writing check", () => {
    const element = document.createElement("div");
    const renderIcon = vi.fn();
    const controller = createRefineStatusBarController({
      element,
      renderIcon,
      onActivate: vi.fn(),
    });

    controller.setState({ type: "checking" });

    const label = "Refine: Checking current note. Open Refine menu";
    expect(element.dataset.refineState).toBe("checking");
    expect(element.title).toBe(label);
    expect(element.getAttribute("aria-label")).toBe(label);
    expect(element.getAttribute("aria-busy")).toBe("true");
    expect(renderIcon).toHaveBeenLastCalledWith(element, "loader-circle");
  });

  it("shows the number of available writing suggestions", () => {
    const element = document.createElement("div");
    const controller = createRefineStatusBarController({
      element,
      renderIcon: vi.fn(),
      onActivate: vi.fn(),
    });

    controller.setState({ type: "suggestions", count: 3 });

    const label = "Refine: 3 suggestions. Open Refine menu";
    expect(element.dataset.refineState).toBe("suggestions");
    expect(element.title).toBe(label);
    expect(element.getAttribute("aria-label")).toBe(label);
    expect(element.querySelector(".refine-status-bar__count")?.textContent).toBe("3");
    expect(
      element.querySelector(".refine-status-bar__count")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("treats a completed check with no suggestions as ready", () => {
    const element = document.createElement("div");
    const controller = createRefineStatusBarController({
      element,
      renderIcon: vi.fn(),
      onActivate: vi.fn(),
    });

    controller.setState({ type: "suggestions", count: 1 });
    expect(element.getAttribute("aria-label")).toBe(
      "Refine: 1 suggestion. Open Refine menu",
    );

    controller.setState({ type: "suggestions", count: 0 });
    expect(element.dataset.refineState).toBe("idle");
    expect(element.getAttribute("aria-label")).toBe(
      "Refine: Ready. Open Refine menu",
    );
    expect(element.querySelector(".refine-status-bar__count")).toBeNull();
  });

  it.each([
    [
      { type: "connecting" } as const,
      "Refine: Connecting. Open Refine menu",
      "loader-circle",
      "true",
    ],
    [
      { type: "disconnected" } as const,
      "Refine: Disconnected. Open Refine menu",
      "unplug",
      null,
    ],
    [
      { type: "error" } as const,
      "Refine: Check unavailable. Open Refine menu",
      "triangle-alert",
      null,
    ],
    [
      { type: "checkFailed" } as const,
      "Refine: Check failed. Open Refine menu",
      "triangle-alert",
      null,
    ],
    [
      { type: "incompatible" } as const,
      "Refine: Incompatible protocol version. Update Refine and the Obsidian plugin. Open Refine menu",
      "triangle-alert",
      null,
    ],
  ])("communicates the %s state", (state, label, icon, ariaBusy) => {
    const element = document.createElement("div");
    const renderIcon = vi.fn();
    const controller = createRefineStatusBarController({
      element,
      renderIcon,
      onActivate: vi.fn(),
    });

    controller.setState(state);

    expect(element.dataset.refineState).toBe(state.type);
    expect(element.title).toBe(label);
    expect(element.getAttribute("aria-label")).toBe(label);
    expect(element.getAttribute("aria-busy")).toBe(ariaBusy);
    expect(renderIcon).toHaveBeenLastCalledWith(element, icon);
  });

  it("opens Refine controls from a pointer activation", () => {
    const element = document.createElement("div");
    const onActivate = vi.fn();
    createRefineStatusBarController({
      element,
      renderIcon: vi.fn(),
      onActivate,
    });
    const event = new MouseEvent("click", { bubbles: true });

    element.dispatchEvent(event);

    expect(onActivate).toHaveBeenCalledOnce();
    expect(onActivate).toHaveBeenCalledWith(event);
  });

  it("opens Refine controls from native button keyboard gestures", () => {
    const element = document.createElement("div");
    const onActivate = vi.fn();
    createRefineStatusBarController({
      element,
      renderIcon: vi.fn(),
      onActivate,
    });
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    const space = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });
    const other = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });

    element.dispatchEvent(enter);
    element.dispatchEvent(space);
    element.dispatchEvent(other);

    expect(onActivate.mock.calls).toEqual([[enter], [space]]);
    expect(enter.defaultPrevented).toBe(true);
    expect(space.defaultPrevented).toBe(true);
    expect(other.defaultPrevented).toBe(false);
  });

  it.each([
    [{ type: "inactive" } as const, { type: "noEditor" } as const],
    [{ type: "starting" } as const, { type: "connecting" } as const],
    [
      { type: "failed", reason: "unavailable" } as const,
      { type: "error" } as const,
    ],
    [
      { type: "failed", reason: "incompatibleProtocol" } as const,
      { type: "incompatible" } as const,
    ],
    [
      presented({ type: "pending" }),
      { type: "idle" } as const,
    ],
    [
      presented({ type: "checking" }),
      { type: "checking" } as const,
    ],
    [
      presented({ type: "complete", coverage: "full" }, 2),
      { type: "suggestions", count: 2 } as const,
    ],
    [
      presented({ type: "complete", coverage: "partial" }, 0),
      { type: "partial", count: 0 } as const,
    ],
    [
      presented({ type: "unavailable", reason: "disconnected" }),
      { type: "disconnected" } as const,
    ],
    [
      presented({ type: "unavailable", reason: "engineUnavailable" }),
      { type: "error" } as const,
    ],
    [
      presented({ type: "unavailable", reason: "checkFailed" }),
      { type: "checkFailed" } as const,
    ],
    [
      presented({ type: "closed" }),
      { type: "noEditor" } as const,
    ],
  ])("derives status state from the active session presentation", (session, expected) => {
    expect(statusBarStateForSession(session)).toEqual(expected);
  });
});

function presented(
  state: PresentationSnapshot["state"],
  suggestionCount = 0,
): ObsidianSessionState {
  return {
    type: "presented",
    snapshot: {
      documentRevision: "revision",
      presentationRevision: 1,
      appearance: DEFAULT_PRESENTATION_APPEARANCE,
      state,
      suggestions: Array.from({ length: suggestionCount }, (_, index) => ({
        id: `suggestion-${index}`,
        sourceId: "document",
        kind: "grammar" as const,
        attribution: {
          languageDisplayName: "English (American)",
          textDirection: "ltr" as const,
          checkModelDisplayName: "On-Device (Gemma)",
        },
        highlightRanges: [],
        diff: [],
        availableActions: [],
      })),
    },
  };
}
