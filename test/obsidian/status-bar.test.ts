// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { PresentationSnapshot } from "../../src/integration/types";
import {
  DEFAULT_PRESENTATION_APPEARANCE,
  DEFAULT_PRESENTATION_INTERACTION,
} from "../../src/integration/types";
import type { ObsidianSessionState } from "../../src/obsidian/session-manager";
import { REFINE_MENU_BAR_ICON_ID } from "../../src/obsidian/icons";
import {
  createRefineStatusBarController,
  statusBarStateForSession,
  statusMenuShowsAutomaticCheckNotice,
  statusMenuShowsCheckControls,
  statusMenuShowsManualCheck,
} from "../../src/obsidian/status-bar";

describe("Refine status bar", () => {
  it("hides check controls from the menu while Refine is disconnected", () => {
    expect(statusMenuShowsCheckControls({ type: "disconnected" })).toBe(false);
    expect(statusMenuShowsCheckControls({ type: "idle" })).toBe(true);
  });

  it("shows a manual check only when automatic checks are unavailable", () => {
    expect(statusMenuShowsManualCheck({
      type: "idle",
      automaticChecksEnabled: true,
    })).toBe(false);
    expect(statusMenuShowsManualCheck({
      type: "idle",
      automaticChecksEnabled: false,
    })).toBe(true);
    expect(statusMenuShowsManualCheck({ type: "idle" })).toBe(false);
    expect(statusMenuShowsManualCheck({
      type: "disconnected",
      automaticChecksEnabled: false,
    })).toBe(false);
  });

  it("offers a manual writing check while an automatic check is pending", () => {
    const state = statusBarStateForSession(
      presented({ type: "pending" }, 0, true),
    );

    expect(statusMenuShowsManualCheck(state)).toBe(true);
    expect(statusMenuShowsAutomaticCheckNotice(state)).toBe(false);
  });

  it("hides the automatic-check notice when the manual check is shown", () => {
    expect(statusMenuShowsAutomaticCheckNotice({
      type: "idle",
      automaticChecksEnabled: true,
    })).toBe(true);
    expect(statusMenuShowsAutomaticCheckNotice({
      type: "idle",
      automaticChecksEnabled: false,
    })).toBe(false);
    expect(statusMenuShowsAutomaticCheckNotice({ type: "idle" })).toBe(true);
    expect(statusMenuShowsAutomaticCheckNotice({
      type: "disconnected",
      automaticChecksEnabled: true,
    })).toBe(false);
  });

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
    });
    expect(element.hasAttribute("title")).toBe(false);
    expect(element.classList.contains("refine-status-bar")).toBe(true);
    expect(element.getAttribute("aria-label")).toBe(
      "Refine: No editable Markdown note. Open Refine menu",
    );
    expect(element.getAttribute("aria-live")).toBe("polite");
    expect(element.dataset.refineState).toBe("noEditor");
    expect(renderIcon).toHaveBeenCalledWith(element, REFINE_MENU_BAR_ICON_ID);
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

  it("uses Obsidian's error color for incompatible versions", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(
      resolve(import.meta.dirname, "../../styles.css"),
      "utf8",
    );
    document.head.append(style);
    try {
      const incompatibleRule = Array.from(style.sheet?.cssRules ?? []).find(
        (rule) =>
          "selectorText" in rule &&
          (rule as CSSStyleRule).selectorText.includes(
            '.refine-status-bar[data-refine-state="incompatible"]',
          ),
      ) as CSSStyleRule | undefined;

      expect(incompatibleRule?.style.color).toBe("var(--text-error)");
    } finally {
      style.remove();
    }
  });

  it("communicates when Refine is idle and ready", () => {
    const element = document.createElement("div");
    element.title = "Previous native tooltip";
    const renderIcon = vi.fn();
    const controller = createRefineStatusBarController({
      element,
      renderIcon,
      onActivate: vi.fn(),
    });

    controller.setState({ type: "idle" });

    const label = "Refine: Ready. Open Refine menu";
    expect(element.dataset.refineState).toBe("idle");
    expect(element.hasAttribute("title")).toBe(false);
    expect(element.getAttribute("aria-label")).toBe(label);
    expect(element.hasAttribute("aria-busy")).toBe(false);
    expect(renderIcon).toHaveBeenLastCalledWith(element, REFINE_MENU_BAR_ICON_ID);
  });

  it("shows that Refine is waiting for an automatic writing check", () => {
    const element = document.createElement("div");
    const renderIcon = vi.fn();
    const controller = createRefineStatusBarController({
      element,
      renderIcon,
      onActivate: vi.fn(),
    });
    const state = statusBarStateForSession(
      presented({ type: "pending" }, 0, true),
    );

    controller.setState(state);

    expect(state).toEqual({
      type: "refreshing",
      automaticChecksEnabled: true,
    });
    expect(element.dataset.refineState).toBe("refreshing");
    expect(element.getAttribute("aria-label")).toBe(
      "Refine: Waiting to check current note. Open Refine menu",
    );
    expect(element.getAttribute("aria-busy")).toBe("true");
    expect(renderIcon).toHaveBeenLastCalledWith(element, "loader-circle");
  });

  it("shows when current changes will not be checked automatically", () => {
    const element = document.createElement("div");
    const controller = createRefineStatusBarController({
      element,
      renderIcon: vi.fn(),
      onActivate: vi.fn(),
    });
    const state = statusBarStateForSession(
      presented({ type: "pending" }, 0, false),
    );

    controller.setState(state);

    expect(state).toEqual({
      type: "changesNotChecked",
      automaticChecksEnabled: false,
    });
    expect(element.dataset.refineState).toBe("changesNotChecked");
    expect(element.getAttribute("aria-label")).toBe(
      "Refine: Changes not checked. Open Refine menu",
    );
    expect(element.hasAttribute("aria-busy")).toBe(false);
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

    controller.setState({ type: "checking", count: 0 });

    const label = "Refine: Checking current note. Open Refine menu";
    expect(element.dataset.refineState).toBe("checking");
    expect(element.hasAttribute("title")).toBe(false);
    expect(element.getAttribute("aria-label")).toBe(label);
    expect(element.getAttribute("aria-busy")).toBe("true");
    expect(renderIcon).toHaveBeenLastCalledWith(element, "loader-circle");
  });

  it("shows determinate checking progress with the current suggestion count", () => {
    const element = document.createElement("div");
    const controller = createRefineStatusBarController({
      element,
      renderIcon: vi.fn(),
      onActivate: vi.fn(),
    });

    controller.setState({
      type: "checking",
      count: 3,
      progress: { completedUnitCount: 2, totalUnitCount: 5 },
    });

    const label =
      "Refine: Checking current note, 2 of 5 units complete, 3 suggestions. " +
      "Open Refine menu";
    expect(element.dataset.refineState).toBe("checking");
    expect(element.hasAttribute("title")).toBe(false);
    expect(element.getAttribute("aria-label")).toBe(label);
    expect(element.getAttribute("aria-busy")).toBeNull();
    expect(element.querySelector(".refine-status-bar__progress")?.textContent).toBe(
      "2/5",
    );
    expect(
      element.querySelector(".refine-status-bar__progress")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(element.querySelector(".refine-status-bar__count")?.textContent).toBe("3");

    controller.setState({
      type: "checking",
      count: 0,
      progress: { completedUnitCount: 0, totalUnitCount: 5 },
    });
    expect(element.getAttribute("aria-label")).toBe(
      "Refine: Checking current note, 0 of 5 units complete, 0 suggestions. " +
        "Open Refine menu",
    );
    expect(element.querySelector(".refine-status-bar__count")?.textContent).toBe("0");
  });

  it("shows the number of available writing suggestions", () => {
    const element = document.createElement("div");
    const renderIcon = vi.fn();
    const controller = createRefineStatusBarController({
      element,
      renderIcon,
      onActivate: vi.fn(),
    });

    controller.setState({ type: "suggestions", count: 3 });

    const label = "Refine: 3 suggestions. Open Refine menu";
    expect(element.dataset.refineState).toBe("suggestions");
    expect(element.hasAttribute("title")).toBe(false);
    expect(element.getAttribute("aria-label")).toBe(label);
    expect(element.querySelector(".refine-status-bar__count")?.textContent).toBe("3");
    expect(
      element.querySelector(".refine-status-bar__count")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(renderIcon).toHaveBeenLastCalledWith(element, REFINE_MENU_BAR_ICON_ID);
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
      REFINE_MENU_BAR_ICON_ID,
      null,
    ],
    [
      { type: "partial", count: 0 } as const,
      "Refine: Partial check. Open Refine menu",
      REFINE_MENU_BAR_ICON_ID,
      null,
    ],
    [
      { type: "error" } as const,
      "Refine: Check unavailable. Open Refine menu",
      REFINE_MENU_BAR_ICON_ID,
      null,
    ],
    [
      { type: "checkFailed" } as const,
      "Refine: Check failed. Open Refine menu",
      REFINE_MENU_BAR_ICON_ID,
      null,
    ],
    [
      {
        type: "incompatible",
        clientProtocol: { major: 1, minor: 0 },
        serverProtocol: { major: 2, minor: 0 },
      } as const,
      "Refine: Protocol 1.0 required; app reports 2.0. Open Refine menu",
      REFINE_MENU_BAR_ICON_ID,
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
    expect(element.hasAttribute("title")).toBe(false);
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
      { type: "failed", reason: "incompatibleEngine" } as const,
      { type: "error" } as const,
    ],
    [
      {
        type: "failed",
        reason: "incompatibleProtocol",
        clientProtocol: { major: 1, minor: 0 },
        serverProtocol: { major: 0, minor: 9 },
      } as const,
      {
        type: "incompatible",
        clientProtocol: { major: 1, minor: 0 },
        serverProtocol: { major: 0, minor: 9 },
      } as const,
    ],
    [
      presented({ type: "pending" }, 0, false),
      { type: "changesNotChecked", automaticChecksEnabled: false } as const,
    ],
    [
      presented({ type: "checking" }),
      {
        type: "checking",
        count: 0,
        automaticChecksEnabled: true,
      } as const,
    ],
    [
      presented(
        {
          type: "checking",
          progress: { completedUnitCount: 2, totalUnitCount: 5 },
        },
        3,
      ),
      {
        type: "checking",
        count: 3,
        progress: { completedUnitCount: 2, totalUnitCount: 5 },
        automaticChecksEnabled: true,
      } as const,
    ],
    [
      presented({ type: "complete", coverage: "full" }, 2),
      {
        type: "suggestions",
        count: 2,
        automaticChecksEnabled: true,
      } as const,
    ],
    [
      presented({ type: "complete", coverage: "partial" }, 0),
      {
        type: "partial",
        count: 0,
        automaticChecksEnabled: true,
      } as const,
    ],
    [
      presented({ type: "unavailable", reason: "disconnected" }),
      { type: "disconnected", automaticChecksEnabled: true } as const,
    ],
    [
      presented({ type: "unavailable", reason: "engineUnavailable" }),
      { type: "error", automaticChecksEnabled: true } as const,
    ],
    [
      presented({ type: "unavailable", reason: "checkFailed" }),
      { type: "checkFailed", automaticChecksEnabled: true } as const,
    ],
    [
      presented({ type: "closed" }),
      { type: "noEditor", automaticChecksEnabled: true } as const,
    ],
  ])("derives status state from the active session presentation", (session, expected) => {
    expect(statusBarStateForSession(session)).toEqual(expected);
  });
});

function presented(
  state: PresentationSnapshot["state"],
  suggestionCount = 0,
  automaticChecksEnabled = true,
): ObsidianSessionState {
  return {
    type: "presented",
    snapshot: {
      documentRevision: "revision",
      presentationRevision: 1,
      checkGeneration: 0,
      appearance: DEFAULT_PRESENTATION_APPEARANCE,
      interaction: {
        ...DEFAULT_PRESENTATION_INTERACTION,
        automaticChecksEnabled,
      },
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
        activationRange: { location: 0, length: 0 },
        highlightRanges: [],
        diff: [],
        availableActions: [],
      })),
    },
  };
}
