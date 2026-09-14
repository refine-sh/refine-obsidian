import { describe, expect, it } from "vitest";
import { ModifierGestureRecognizer } from "../../src/integration/modifier-gesture-recognizer";
import { type PhysicalModifier } from "../../src/integration/suggestion-binding";

const chord = { kind: "modifierChord" as const, keys: ["AltLeft", "AltRight"] as const, label: "Both Options" };
const doubleTap = { kind: "modifierDoubleTap" as const, key: "AltRight" as const, label: "Double-tap Right Option" };

describe("modifier-only gesture recognition", () => {
  it.each([["AltLeft", "AltRight"], ["AltRight", "AltLeft"]] as const)("fires after full release in either order: %s then %s", (first, second) => {
    const recognizer = new ModifierGestureRecognizer(chord);
    expect(recognizer.update(new Set([first]), 0)).toBe(false);
    expect(recognizer.update(new Set([first, second]), 100)).toBe(false);
    expect(recognizer.update(new Set([second]), 200)).toBe(false);
    expect(recognizer.update(new Set(), 300)).toBe(true);
    expect(recognizer.update(new Set(), 400)).toBe(false);
  });

  it.each([499, 500, 501])("requires two completed taps within 500 ms (%s)", (end) => {
    const recognizer = new ModifierGestureRecognizer(doubleTap);
    expect(recognizer.update(new Set(["AltRight"]), 0)).toBe(false);
    expect(recognizer.update(new Set(), 100)).toBe(false);
    expect(recognizer.update(new Set(["AltRight"]), 200)).toBe(false);
    expect(recognizer.update(new Set(), end)).toBe(end <= 500);
  });

  it.each([
    [["AltLeft"], [], ["AltRight"], []],
    [["AltLeft"], ["AltLeft", "AltRight", "ShiftLeft"], []],
    [["AltLeft"], ["AltLeft", "ShiftRight"], []],
  ] as PhysicalModifier[][][])("rejects nonoverlapping, extra, and wrong modifiers: %j", (...sequence) => {
    const recognizer = new ModifierGestureRecognizer(chord);
    sequence.forEach((pressed, index) => expect(recognizer.update(new Set(pressed), index * 50)).toBe(false));
  });

  it("cancels on interruption without allowing release to complete a gesture", () => {
    const recognizer = new ModifierGestureRecognizer(chord);
    recognizer.update(new Set(["AltLeft", "AltRight"]), 0);
    recognizer.cancel();
    expect(recognizer.update(new Set(["AltRight"]), 100)).toBe(false);
    expect(recognizer.update(new Set(), 200)).toBe(false);
    expect(recognizer.update(new Set(["AltLeft", "AltRight"]), 300)).toBe(false);
    expect(recognizer.update(new Set(), 400)).toBe(true);
  });
});
