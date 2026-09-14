import { isModifierGesture, gestureKeys, type SuggestionBinding } from "./suggestion-binding";
import type { SuggestionActionKey } from "./types";

export const SUGGESTION_SHORTCUT_CAPABILITY = "com.runjuu.refine.suggestion-shortcuts.v1";
export const SHORTCUT_CODES: readonly string[] = ["KeyA", "KeyS", "KeyD", "KeyF", "KeyH", "KeyG", "KeyZ", "KeyX", "KeyC", "KeyV", "IntlBackslash", "KeyB", "KeyQ", "KeyW", "KeyE", "KeyR", "KeyY", "KeyT", "Digit1", "Digit2", "Digit3", "Digit4", "Digit6", "Digit5", "Equal", "Digit9", "Digit7", "Minus", "Digit8", "Digit0", "BracketRight", "KeyO", "KeyU", "BracketLeft", "KeyI", "KeyP", "Enter", "KeyL", "KeyJ", "Quote", "KeyK", "Semicolon", "Backslash", "Comma", "Slash", "KeyN", "KeyM", "Period", "Tab", "Space", "Backquote", "Backspace", "Escape", "ShiftLeft", "AltLeft", "ControlLeft", "ShiftRight", "AltRight", "ControlRight", "F17", "NumpadDecimal", "NumpadMultiply", "NumpadAdd", "NumLock", "NumpadDivide", "NumpadEnter", "NumpadSubtract", "F18", "F19", "NumpadEqual", "Numpad0", "Numpad1", "Numpad2", "Numpad3", "Numpad4", "Numpad5", "Numpad6", "Numpad7", "F20", "Numpad8", "Numpad9", "IntlYen", "IntlRo", "NumpadComma", "F5", "F6", "F7", "F3", "F8", "F9", "F11", "F13", "F16", "F14", "F10", "F12", "F15", "Insert", "Home", "PageUp", "Delete", "F4", "End", "F2", "PageDown", "F1", "ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"];
export const SHORTCUT_MODIFIERS = ["control", "option", "shift", "command"] as const;
export type ShortcutModifier = (typeof SHORTCUT_MODIFIERS)[number];

export interface SuggestionShortcut {
  readonly code: string;
  readonly key: string;
  readonly modifiers: readonly ShortcutModifier[];
  readonly label: string;
}

export function isSuggestionShortcut(value: unknown): value is SuggestionShortcut {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const shortcut = value as Record<string, unknown>;
  if (typeof shortcut.code !== "string" || !SHORTCUT_CODES.includes(shortcut.code) ||
      typeof shortcut.key !== "string" || Array.from(shortcut.key).length > 32 ||
      typeof shortcut.label !== "string" || shortcut.label.length === 0 || Array.from(shortcut.label).length > 128 ||
      !Array.isArray(shortcut.modifiers) || new Set(shortcut.modifiers).size !== shortcut.modifiers.length ||
      shortcut.modifiers.some((modifier: unknown) => !SHORTCUT_MODIFIERS.some((allowed) => allowed === modifier))) return false;
  const modifiers = shortcut.modifiers as ShortcutModifier[];
  if (/^(Shift|Alt|Control)(Left|Right)$/.test(shortcut.code)) return modifiers.length === 0;
  const printable = /^(Key|Digit|Intl|Numpad)/.test(shortcut.code) ||
    ["Equal", "Minus", "BracketRight", "BracketLeft", "Quote", "Semicolon", "Backslash", "Comma", "Slash", "Period", "Backquote"].includes(shortcut.code);
  return !printable || modifiers.some((modifier) => modifier !== "shift");
}

export function effectiveSuggestionShortcut(
  configuration: { readonly applyKey: SuggestionActionKey; readonly dismissKey: SuggestionActionKey;
    readonly applyShortcut?: SuggestionShortcut | SuggestionBinding; readonly dismissShortcut?: SuggestionShortcut | SuggestionBinding },
  action: "apply" | "dismiss",
): SuggestionActionKey | SuggestionShortcut | SuggestionBinding {
  return action === "apply" ? configuration.applyShortcut ?? configuration.applyKey
    : configuration.dismissShortcut ?? configuration.dismissKey;
}

export function suggestionShortcutsConflict(configuration: Parameters<typeof effectiveSuggestionShortcut>[0]): boolean {
  if (!configuration.applyShortcut && !configuration.dismissShortcut) return false;
  const codes: Record<SuggestionActionKey, string> = {
    tab: "Tab", escape: "Escape", return: "Enter", space: "Space", delete: "Backspace",
    leftArrow: "ArrowLeft", rightArrow: "ArrowRight", upArrow: "ArrowUp", downArrow: "ArrowDown",
    leftShift: "ShiftLeft", rightShift: "ShiftRight", leftOption: "AltLeft", rightOption: "AltRight",
    leftControl: "ControlLeft", rightControl: "ControlRight",
  };
  const identity = (action: "apply" | "dismiss") => {
    const shortcut = effectiveSuggestionShortcut(configuration, action);
    return typeof shortcut === "string" ? { code: codes[shortcut], modifiers: [] as readonly ShortcutModifier[] } : shortcut;
  };
  const apply = identity("apply");
  const dismiss = identity("dismiss");
  const applyGesture = "kind" in apply && isModifierGesture(apply) ? apply : undefined;
  const dismissGesture = "kind" in dismiss && isModifierGesture(dismiss) ? dismiss : undefined;
  if (applyGesture && dismissGesture) {
    return applyGesture.kind === dismissGesture.kind &&
      gestureKeys(applyGesture).length === gestureKeys(dismissGesture).length &&
      gestureKeys(applyGesture).every((key) => gestureKeys(dismissGesture).includes(key));
  }
  if (applyGesture || dismissGesture) {
    const gesture = applyGesture ?? dismissGesture;
    const key = applyGesture ? dismiss : apply;
    return gesture !== undefined && "code" in key && key.modifiers.length === 0 &&
      gestureKeys(gesture).some((physical) => physical === key.code);
  }
  if (!("code" in apply) || !("code" in dismiss)) return false;
  const prefix = (one: Pick<SuggestionShortcut, "code" | "modifiers">, other: Pick<SuggestionShortcut, "code" | "modifiers">): boolean => {
    const modifier = one.code.startsWith("Alt") ? "option" : one.code.startsWith("Shift") ? "shift" : one.code.startsWith("Control") ? "control" : undefined;
    return modifier !== undefined && other.modifiers.includes(modifier);
  };
  return (apply.code === dismiss.code && SHORTCUT_MODIFIERS.every((modifier) => apply.modifiers.includes(modifier) === dismiss.modifiers.includes(modifier))) || prefix(apply, dismiss) || prefix(dismiss, apply);
}
