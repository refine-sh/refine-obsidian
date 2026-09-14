import { isSuggestionShortcut, type SuggestionShortcut } from "./suggestion-shortcut";

export const SUGGESTION_GESTURE_CAPABILITY = "com.runjuu.refine.suggestion-shortcuts.v2";
export const PHYSICAL_MODIFIERS = ["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"] as const;
export type PhysicalModifier = (typeof PHYSICAL_MODIFIERS)[number];
export type ModifierGesture =
  | { readonly kind: "modifierChord"; readonly keys: readonly PhysicalModifier[]; readonly label: string }
  | { readonly kind: "modifierDoubleTap"; readonly key: PhysicalModifier; readonly label: string };
export type SuggestionBinding = (SuggestionShortcut & { readonly kind: "keyCombination" }) | ModifierGesture;

export function isPhysicalModifier(value: unknown): value is PhysicalModifier {
  return typeof value === "string" && PHYSICAL_MODIFIERS.some((key) => key === value);
}

export function isModifierGesture(value: SuggestionShortcut | SuggestionBinding): value is ModifierGesture {
  return "kind" in value && (value.kind === "modifierChord" || value.kind === "modifierDoubleTap");
}

export function gestureKeys(gesture: ModifierGesture): readonly PhysicalModifier[] {
  return gesture.kind === "modifierChord" ? gesture.keys : [gesture.key];
}

export function isSuggestionBinding(value: unknown): value is SuggestionBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  if (typeof binding.label !== "string" || !binding.label.length || Array.from(binding.label).length > 128) return false;
  if (binding.kind === "keyCombination") return isSuggestionShortcut(value);
  if (binding.kind === "modifierDoubleTap") return isPhysicalModifier(binding.key);
  return binding.kind === "modifierChord" && Array.isArray(binding.keys) && binding.keys.length >= 2 &&
    binding.keys.every(isPhysicalModifier) && new Set(binding.keys).size === binding.keys.length;
}
