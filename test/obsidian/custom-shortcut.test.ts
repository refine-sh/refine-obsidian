// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isSuggestionShortcut, type SuggestionShortcut } from "../../src/integration/suggestion-shortcut";
import { matchesSuggestionActionKey, suggestionActionKeyLabel } from "../../src/obsidian/quick-apply";

const shortcut: SuggestionShortcut = { code: "ArrowRight", key: "ArrowRight", modifiers: ["option"], label: "⌥→" };

describe("custom suggestion shortcuts", () => {
  it("matches Option+Right Arrow without stealing plain or extra-modifier input", () => {
    expect(matchesSuggestionActionKey(new KeyboardEvent("keydown", { code: "ArrowRight", altKey: true }), shortcut)).toBe(true);
    for (const event of [
      new KeyboardEvent("keydown", { code: "Tab", key: "Tab" }),
      new KeyboardEvent("keydown", { code: "ArrowRight" }),
      new KeyboardEvent("keydown", { code: "ArrowRight", altKey: true, shiftKey: true }),
      new KeyboardEvent("keydown", { code: "ArrowRight", altKey: true, isComposing: true }),
      new KeyboardEvent("keydown", { code: "ArrowRight", altKey: true, repeat: true }),
    ]) expect(matchesSuggestionActionKey(event, shortcut)).toBe(false);
    expect(suggestionActionKeyLabel(shortcut)).toBe("⌥→");
  });

  it("uses physical codes even when Option changes the generated character", () => {
    const letter: SuggestionShortcut = { code: "KeyK", key: "k", modifiers: ["option"], label: "⌥K" };
    expect(matchesSuggestionActionKey(new KeyboardEvent("keydown", { code: "KeyK", key: "˚", altKey: true }), letter)).toBe(true);
    expect(matchesSuggestionActionKey(new KeyboardEvent("keydown", { code: "KeyJ", key: "k", altKey: true }), letter)).toBe(false);
  });

  it("rejects unsafe and malformed shortcut representations", () => {
    expect(isSuggestionShortcut(shortcut)).toBe(true);
    expect(isSuggestionShortcut({ ...shortcut, modifiers: ["option", "option"] })).toBe(false);
    expect(isSuggestionShortcut({ ...shortcut, code: "Unknown" })).toBe(false);
    expect(isSuggestionShortcut({ ...shortcut, code: "KeyK", modifiers: [] })).toBe(false);
    expect(isSuggestionShortcut({ ...shortcut, code: "KeyK", modifiers: ["shift"] })).toBe(false);
    expect(isSuggestionShortcut({ ...shortcut, code: "AltLeft", modifiers: ["shift"] })).toBe(false);
  });
});
