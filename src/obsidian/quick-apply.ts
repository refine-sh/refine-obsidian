import type { EditorSelection } from "@codemirror/state";

import type {
  PresentedSuggestion,
  SuggestionActionKey,
  UTF16Range,
} from "../integration/types";

type Modifier = "alt" | "control" | "shift";

interface ModifierKeyMatch {
  readonly code: string;
  readonly key: "Alt" | "Control" | "Shift";
  readonly modifier: Modifier;
}

interface OrdinaryKeyMatch {
  readonly code: string;
  readonly key: string;
}

const ordinaryEventKeys: Record<
  Exclude<
    SuggestionActionKey,
    | "leftShift"
    | "rightShift"
    | "leftOption"
    | "rightOption"
    | "leftControl"
    | "rightControl"
  >,
  OrdinaryKeyMatch
> = {
  tab: { key: "Tab", code: "Tab" },
  escape: { key: "Escape", code: "Escape" },
  return: { key: "Enter", code: "Enter" },
  space: { key: " ", code: "Space" },
  delete: { key: "Backspace", code: "Backspace" },
  leftArrow: { key: "ArrowLeft", code: "ArrowLeft" },
  rightArrow: { key: "ArrowRight", code: "ArrowRight" },
  upArrow: { key: "ArrowUp", code: "ArrowUp" },
  downArrow: { key: "ArrowDown", code: "ArrowDown" },
};

const modifierEventKeys: Record<
  Extract<
    SuggestionActionKey,
    | "leftShift"
    | "rightShift"
    | "leftOption"
    | "rightOption"
    | "leftControl"
    | "rightControl"
  >,
  ModifierKeyMatch
> = {
  leftShift: { key: "Shift", code: "ShiftLeft", modifier: "shift" },
  rightShift: { key: "Shift", code: "ShiftRight", modifier: "shift" },
  leftOption: { key: "Alt", code: "AltLeft", modifier: "alt" },
  rightOption: { key: "Alt", code: "AltRight", modifier: "alt" },
  leftControl: { key: "Control", code: "ControlLeft", modifier: "control" },
  rightControl: { key: "Control", code: "ControlRight", modifier: "control" },
};

const actionKeyLabels: Record<SuggestionActionKey, string> = {
  tab: "Tab",
  escape: "Esc",
  return: "Return",
  space: "Space",
  delete: "Delete",
  leftArrow: "Left Arrow",
  rightArrow: "Right Arrow",
  upArrow: "Up Arrow",
  downArrow: "Down Arrow",
  leftShift: "Left Shift",
  rightShift: "Right Shift",
  leftOption: "Left Option",
  rightOption: "Right Option",
  leftControl: "Left Control",
  rightControl: "Right Control",
};

/**
 * Returns the live suggestion owned by a single collapsed CodeMirror cursor.
 * The engine-authored activation range is intentionally independent from the
 * display-only highlight fragments.
 */
export function bestQuickApplySuggestion(
  selection: EditorSelection,
  suggestions: readonly PresentedSuggestion[],
): PresentedSuggestion | undefined {
  let best: PresentedSuggestion | undefined;
  for (const suggestion of suggestions) {
    if (!isQuickApplyCandidate(selection, suggestion)) {
      continue;
    }
    if (best === undefined || compareQuickApplyPriority(suggestion, best) < 0) {
      best = suggestion;
    }
  }
  return best;
}

export function isQuickApplyCandidate(
  selection: EditorSelection,
  suggestion: PresentedSuggestion,
): boolean {
  return selection.ranges.length === 1 &&
    selection.main.empty &&
    suggestion.sourceId === "document" &&
    suggestion.availableActions.includes("apply") &&
    rangeContainsCursor(suggestion.activationRange, selection.main.head);
}

/** Matches one unmodified key press to Refine's configured action key. */
export function matchesSuggestionActionKey(
  event: KeyboardEvent,
  actionKey: SuggestionActionKey,
): boolean {
  if (event.type !== "keydown" || event.repeat || event.isComposing) {
    return false;
  }

  if (actionKey in ordinaryEventKeys) {
    const key = actionKey as keyof typeof ordinaryEventKeys;
    const expected = ordinaryEventKeys[key];
    return !hasAnyModifier(event) &&
      event.key === expected.key &&
      event.code === expected.code;
  }

  const expected = modifierEventKeys[actionKey as keyof typeof modifierEventKeys];
  return event.key === expected.key &&
    event.code === expected.code &&
    hasOnlyModifier(event, expected.modifier);
}

export function suggestionActionKeyLabel(actionKey: SuggestionActionKey): string {
  return actionKeyLabels[actionKey];
}

function rangeContainsCursor(range: UTF16Range, cursor: number): boolean {
  const end = range.location + range.length;
  return Number.isSafeInteger(range.location) &&
    Number.isSafeInteger(range.length) &&
    range.location >= 0 &&
    range.length >= 0 &&
    Number.isSafeInteger(end) &&
    cursor >= range.location &&
    cursor <= end;
}

function compareQuickApplyPriority(
  left: PresentedSuggestion,
  right: PresentedSuggestion,
): number {
  if (left.activationRange.length !== right.activationRange.length) {
    return left.activationRange.length < right.activationRange.length ? -1 : 1;
  }
  const kind = suggestionKindRank(left) - suggestionKindRank(right);
  if (kind !== 0) {
    return kind;
  }
  if (left.activationRange.location !== right.activationRange.location) {
    return left.activationRange.location < right.activationRange.location ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function suggestionKindRank(suggestion: PresentedSuggestion): number {
  return suggestion.kind === "grammar" ? 0 : 1;
}

function hasAnyModifier(event: KeyboardEvent): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

function hasOnlyModifier(event: KeyboardEvent, modifier: Modifier): boolean {
  if (event.metaKey) {
    return false;
  }
  return modifier === "shift"
    ? event.shiftKey && !event.altKey && !event.ctrlKey
    : modifier === "alt"
      ? event.altKey && !event.ctrlKey && !event.shiftKey
      : event.ctrlKey && !event.altKey && !event.shiftKey;
}
