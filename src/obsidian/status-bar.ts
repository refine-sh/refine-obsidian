import type { CheckingProgress } from "../integration/types";
import type { RequiredCompatibilityUpdate } from "../transport/refine-transport";
import { incompatibleProtocolStatus } from "./compatibility";
import type { ObsidianSessionState } from "./session-manager";

export type RefineStatusBarState = (
  | { readonly type: "noEditor" }
  | { readonly type: "idle" }
  | { readonly type: "connecting" }
  | { readonly type: "disconnected" }
  | {
      readonly type: "checking";
      readonly count: number;
      readonly progress?: CheckingProgress;
    }
  | { readonly type: "suggestions"; readonly count: number }
  | { readonly type: "partial"; readonly count: number }
  | { readonly type: "checkFailed" }
  | {
      readonly type: "incompatible";
      readonly requiredUpdate: RequiredCompatibilityUpdate;
    }
  | { readonly type: "error" }
) & { readonly automaticChecksEnabled?: boolean };

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

export function statusMenuShowsCheckControls(
  state: RefineStatusBarState,
): boolean {
  return state.type !== "disconnected";
}

export function statusMenuShowsManualCheck(
  state: RefineStatusBarState,
): boolean {
  return statusMenuShowsCheckControls(state) &&
    state.automaticChecksEnabled === false;
}

export function statusMenuShowsAutomaticCheckNotice(
  state: RefineStatusBarState,
): boolean {
  return statusMenuShowsCheckControls(state) &&
    state.automaticChecksEnabled !== false;
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
          checkingLabel(state),
          "loader-circle",
          state.progress === undefined,
        );
        if (state.progress !== undefined) {
          appendCheckingProgress(element, state.progress);
        }
        appendSuggestionCount(element, state.count, state.progress !== undefined);
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
          incompatibleProtocolStatus(state.requiredUpdate),
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
      ? { type: "incompatible", requiredUpdate: session.requiredUpdate }
      : { type: "error" };
  }

  const { snapshot } = session;
  const automaticChecksEnabled = snapshot.interaction.automaticChecksEnabled;
  switch (snapshot.state.type) {
    case "pending":
      return { type: "idle", automaticChecksEnabled };
    case "checking":
      return snapshot.state.progress === undefined
        ? {
            type: "checking",
            count: snapshot.suggestions.length,
            automaticChecksEnabled,
          }
        : {
            type: "checking",
            count: snapshot.suggestions.length,
            progress: snapshot.state.progress,
            automaticChecksEnabled,
          };
    case "complete":
      return snapshot.state.coverage === "partial"
        ? {
            type: "partial",
            count: snapshot.suggestions.length,
            automaticChecksEnabled,
          }
        : {
            type: "suggestions",
            count: snapshot.suggestions.length,
            automaticChecksEnabled,
          };
    case "unavailable":
      if (snapshot.state.reason === "disconnected") {
        return { type: "disconnected", automaticChecksEnabled };
      }
      if (snapshot.state.reason === "checkFailed") {
        return { type: "checkFailed", automaticChecksEnabled };
      }
      return { type: "error", automaticChecksEnabled };
    case "closed":
      return { type: "noEditor", automaticChecksEnabled };
  }
}

function checkingLabel(
  state: Extract<RefineStatusBarState, { type: "checking" }>,
): string {
  const details: string[] = [];
  if (state.progress !== undefined) {
    const { completedUnitCount, totalUnitCount } = state.progress;
    details.push(
      `${completedUnitCount} of ${totalUnitCount} ` +
        `${totalUnitCount === 1 ? "unit" : "units"} complete`,
    );
  }
  if (state.count > 0 || state.progress !== undefined) {
    details.push(`${state.count} ${state.count === 1 ? "suggestion" : "suggestions"}`);
  }
  return details.length === 0
    ? CHECKING_LABEL
    : `Refine: Checking current note, ${details.join(", ")}. Open Refine menu`;
}

function appendCheckingProgress(
  element: HTMLElement,
  progress: CheckingProgress,
): void {
  const indicator = element.ownerDocument.createElement("span");
  indicator.className = "refine-status-bar__progress";
  indicator.textContent = `${progress.completedUnitCount}/${progress.totalUnitCount}`;
  indicator.setAttribute("aria-hidden", "true");
  element.append(indicator);
}

function appendSuggestionCount(
  element: HTMLElement,
  count: number,
  includeZero = false,
): void {
  if (count === 0 && !includeZero) {
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
