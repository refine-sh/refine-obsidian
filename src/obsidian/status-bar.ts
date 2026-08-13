import type { ObsidianSessionState } from "./session-manager";

export type RefineStatusBarState =
  | { readonly type: "noEditor" }
  | { readonly type: "idle" }
  | { readonly type: "connecting" }
  | { readonly type: "disconnected" }
  | { readonly type: "checking" }
  | { readonly type: "suggestions"; readonly count: number }
  | { readonly type: "partial"; readonly count: number }
  | { readonly type: "checkFailed" }
  | { readonly type: "incompatible" }
  | { readonly type: "error" };

export type RefineStatusBarActivationEvent = MouseEvent | KeyboardEvent;

export interface RefineStatusBarController {
  setState(state: RefineStatusBarState): void;
  dispose(): void;
}

export interface RefineStatusBarControllerOptions {
  readonly element: HTMLElement;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly onActivate: (event: RefineStatusBarActivationEvent) => void;
}

const NO_EDITOR_LABEL = "Refine: No editable Markdown note. Open Refine menu";
const IDLE_LABEL = "Refine: Ready. Open Refine menu";
const CHECKING_LABEL = "Refine: Checking current note. Open Refine menu";

export function createRefineStatusBarController(
  options: RefineStatusBarControllerOptions,
): RefineStatusBarController {
  const { element, renderIcon } = options;
  element.classList.add("refine-status-bar");
  element.role = "button";
  element.tabIndex = 0;
  element.setAttribute("aria-live", "polite");
  renderState(element, renderIcon, "noEditor", NO_EDITOR_LABEL, "spell-check-2");
  const activateFromPointer = (event: MouseEvent): void => options.onActivate(event);
  const activateFromKeyboard = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    options.onActivate(event);
  };
  element.addEventListener("click", activateFromPointer);
  element.addEventListener("keydown", activateFromKeyboard);

  return {
    setState: (state) => {
      if (state.type === "noEditor") {
        renderState(element, renderIcon, "noEditor", NO_EDITOR_LABEL, "spell-check-2");
      } else if (state.type === "idle") {
        renderState(element, renderIcon, "idle", IDLE_LABEL, "spell-check-2");
      } else if (state.type === "connecting") {
        renderState(
          element,
          renderIcon,
          "connecting",
          "Refine: Connecting. Open Refine menu",
          "loader-circle",
          true,
        );
      } else if (state.type === "disconnected") {
        renderState(
          element,
          renderIcon,
          "disconnected",
          "Refine: Disconnected. Open Refine menu",
          "unplug",
        );
      } else if (state.type === "checking") {
        renderState(
          element,
          renderIcon,
          "checking",
          CHECKING_LABEL,
          "loader-circle",
          true,
        );
      } else if (state.type === "suggestions") {
        if (state.count === 0) {
          renderState(element, renderIcon, "idle", IDLE_LABEL, "spell-check-2");
          return;
        }
        const suffix = state.count === 1 ? "suggestion" : "suggestions";
        renderState(
          element,
          renderIcon,
          "suggestions",
          `Refine: ${state.count} ${suffix}. Open Refine menu`,
          "spell-check-2",
        );
        appendSuggestionCount(element, state.count);
      } else if (state.type === "partial") {
        const suggestionText =
          state.count === 0
            ? "Partial check"
            : `${state.count} ${state.count === 1 ? "suggestion" : "suggestions"}, partial check`;
        renderState(
          element,
          renderIcon,
          "partial",
          `Refine: ${suggestionText}. Open Refine menu`,
          "triangle-alert",
        );
        appendSuggestionCount(element, state.count);
      } else if (state.type === "error") {
        renderState(
          element,
          renderIcon,
          "error",
          "Refine: Check unavailable. Open Refine menu",
          "triangle-alert",
        );
      } else if (state.type === "checkFailed") {
        renderState(
          element,
          renderIcon,
          "checkFailed",
          "Refine: Check failed. Open Refine menu",
          "triangle-alert",
        );
      } else if (state.type === "incompatible") {
        renderState(
          element,
          renderIcon,
          "incompatible",
          "Refine: Incompatible protocol version. Update Refine and the Obsidian plugin. Open Refine menu",
          "triangle-alert",
        );
      }
    },
    dispose: () => {
      element.removeEventListener("click", activateFromPointer);
      element.removeEventListener("keydown", activateFromKeyboard);
    },
  };
}

export function statusBarStateForSession(
  session: ObsidianSessionState,
): RefineStatusBarState {
  if (session.type === "inactive") {
    return { type: "noEditor" };
  }
  if (session.type === "starting") {
    return { type: "connecting" };
  }
  if (session.type === "failed") {
    return session.reason === "incompatibleProtocol"
      ? { type: "incompatible" }
      : { type: "error" };
  }

  const { snapshot } = session;
  switch (snapshot.state.type) {
    case "pending":
      return { type: "idle" };
    case "checking":
      return { type: "checking" };
    case "complete":
      return snapshot.state.coverage === "partial"
        ? { type: "partial", count: snapshot.suggestions.length }
        : { type: "suggestions", count: snapshot.suggestions.length };
    case "unavailable":
      if (snapshot.state.reason === "disconnected") {
        return { type: "disconnected" };
      }
      if (snapshot.state.reason === "checkFailed") {
        return { type: "checkFailed" };
      }
      return { type: "error" };
    case "closed":
      return { type: "noEditor" };
  }
}

function appendSuggestionCount(element: HTMLElement, count: number): void {
  if (count === 0) {
    return;
  }
  const badge = element.ownerDocument.createElement("span");
  badge.className = "refine-status-bar__count";
  badge.textContent = String(count);
  badge.setAttribute("aria-hidden", "true");
  element.append(badge);
}

function renderState(
  element: HTMLElement,
  renderIcon: (element: HTMLElement, icon: string) => void,
  state: RefineStatusBarState["type"],
  label: string,
  icon: string,
  busy = false,
): void {
  element.replaceChildren();
  element.dataset.refineState = state;
  element.title = label;
  element.setAttribute("aria-label", label);
  if (busy) {
    element.setAttribute("aria-busy", "true");
  } else {
    element.removeAttribute("aria-busy");
  }
  renderIcon(element, icon);
}
