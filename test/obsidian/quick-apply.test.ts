import { EditorSelection } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import type {
  PresentedSuggestion,
  SuggestionActionKey,
} from "../../src/integration/types";
import {
  bestQuickApplySuggestion,
  matchesSuggestionActionKey,
  suggestionActionKeyLabel,
} from "../../src/obsidian/quick-apply";

describe("Obsidian quick Apply", () => {
  it("uses the full activation scope rather than its separated highlight fragments", () => {
    const scoped = suggestion("sentence", 2, 28, {
      highlightRanges: [
        { location: 2, length: 6 },
        { location: 24, length: 5 },
      ],
    });

    expect(bestQuickApplySuggestion(EditorSelection.single(16), [scoped]))
      .toBe(scoped);
  });

  it("includes both activation-range boundaries and an exact zero-length anchor", () => {
    const ranged = suggestion("ranged", 10, 4);
    const insertion = suggestion("insertion", 20, 0);

    expect(bestQuickApplySuggestion(EditorSelection.single(10), [ranged])?.id)
      .toBe("ranged");
    expect(bestQuickApplySuggestion(EditorSelection.single(14), [ranged])?.id)
      .toBe("ranged");
    expect(bestQuickApplySuggestion(EditorSelection.single(15), [ranged]))
      .toBeUndefined();
    expect(bestQuickApplySuggestion(EditorSelection.single(20), [insertion])?.id)
      .toBe("insertion");
    expect(bestQuickApplySuggestion(EditorSelection.single(19), [insertion]))
      .toBeUndefined();
  });

  it("prioritizes shortest range, grammar, earlier location, then stable ID", () => {
    const candidates = [
      suggestion("wide", 0, 20, { kind: "grammar" }),
      suggestion("narrow-fluency", 8, 4, { kind: "fluency" }),
      suggestion("later-grammar", 9, 4, { kind: "grammar" }),
      suggestion("z-grammar", 8, 4, { kind: "grammar" }),
      suggestion("a-grammar", 8, 4, { kind: "grammar" }),
    ];

    expect(bestQuickApplySuggestion(EditorSelection.single(10), candidates)?.id)
      .toBe("a-grammar");
  });

  it("requires one collapsed selection and an apply-capable document suggestion", () => {
    const live = suggestion("live", 0, 10);
    const nonDocument = suggestion("other-source", 0, 10, {
      sourceId: "other",
    });
    const dismissOnly = suggestion("dismiss-only", 0, 10, {
      availableActions: ["dismiss"],
    });
    const invalidRange = suggestion("invalid-range", -1, 4);

    expect(bestQuickApplySuggestion(EditorSelection.single(1, 3), [live]))
      .toBeUndefined();
    expect(bestQuickApplySuggestion(EditorSelection.create([
      EditorSelection.cursor(1),
      EditorSelection.cursor(3),
    ]), [live])).toBeUndefined();
    expect(bestQuickApplySuggestion(EditorSelection.single(3), [
      nonDocument,
      dismissOnly,
      invalidRange,
    ])).toBeUndefined();
  });
});

interface ActionKeyCase {
  readonly event: Partial<KeyboardEvent> & Pick<KeyboardEvent, "code" | "key">;
  readonly label: string;
}

const actionKeyCases: Record<SuggestionActionKey, ActionKeyCase> = {
  tab: { event: { key: "Tab", code: "Tab" }, label: "Tab" },
  escape: { event: { key: "Escape", code: "Escape" }, label: "Esc" },
  return: { event: { key: "Enter", code: "Enter" }, label: "Return" },
  space: { event: { key: " ", code: "Space" }, label: "Space" },
  delete: { event: { key: "Backspace", code: "Backspace" }, label: "Delete" },
  leftArrow: {
    event: { key: "ArrowLeft", code: "ArrowLeft" },
    label: "Left Arrow",
  },
  rightArrow: {
    event: { key: "ArrowRight", code: "ArrowRight" },
    label: "Right Arrow",
  },
  upArrow: {
    event: { key: "ArrowUp", code: "ArrowUp" },
    label: "Up Arrow",
  },
  downArrow: {
    event: { key: "ArrowDown", code: "ArrowDown" },
    label: "Down Arrow",
  },
  leftShift: {
    event: { key: "Shift", code: "ShiftLeft", shiftKey: true },
    label: "Left Shift",
  },
  rightShift: {
    event: { key: "Shift", code: "ShiftRight", shiftKey: true },
    label: "Right Shift",
  },
  leftOption: {
    event: { key: "Alt", code: "AltLeft", altKey: true },
    label: "Left Option",
  },
  rightOption: {
    event: { key: "Alt", code: "AltRight", altKey: true },
    label: "Right Option",
  },
  leftControl: {
    event: { key: "Control", code: "ControlLeft", ctrlKey: true },
    label: "Left Control",
  },
  rightControl: {
    event: { key: "Control", code: "ControlRight", ctrlKey: true },
    label: "Right Control",
  },
};

const actionKeys = Object.keys(actionKeyCases) as SuggestionActionKey[];

describe("Obsidian quick Apply action keys", () => {
  it.each(actionKeys)("matches the bare %s event and returns its label", (actionKey) => {
    const candidate = keyboardEvent(actionKeyCases[actionKey].event);

    for (const comparedKey of actionKeys) {
      expect(matchesSuggestionActionKey(candidate, comparedKey)).toBe(
        comparedKey === actionKey,
      );
    }
    expect(suggestionActionKeyLabel(actionKey)).toBe(
      actionKeyCases[actionKey].label,
    );
  });

  it.each(["altKey", "ctrlKey", "metaKey", "shiftKey"] as const)(
    "rejects Tab and Right Arrow with the unrelated %s modifier",
    (modifier) => {
      expect(matchesSuggestionActionKey(keyboardEvent({
        ...actionKeyCases.tab.event,
        [modifier]: true,
      }), "tab")).toBe(false);
      expect(matchesSuggestionActionKey(keyboardEvent({
        ...actionKeyCases.rightArrow.event,
        [modifier]: true,
      }), "rightArrow")).toBe(false);
    },
  );

  it("distinguishes modifier sides and requires a bare modifier press", () => {
    expect(matchesSuggestionActionKey(keyboardEvent({
      key: "Shift",
      code: "ShiftLeft",
      shiftKey: true,
    }), "rightShift")).toBe(false);
    expect(matchesSuggestionActionKey(keyboardEvent({
      key: "Shift",
      code: "ShiftRight",
    }), "rightShift")).toBe(false);
    expect(matchesSuggestionActionKey(keyboardEvent({
      key: "Shift",
      code: "ShiftRight",
      shiftKey: true,
      altKey: true,
    }), "rightShift")).toBe(false);
  });

  it.each([
    ["return", "Enter", "NumpadEnter"],
    ["leftArrow", "ArrowLeft", "Numpad4"],
    ["rightArrow", "ArrowRight", "Numpad6"],
    ["upArrow", "ArrowUp", "Numpad8"],
    ["downArrow", "ArrowDown", "Numpad2"],
  ] as const)(
    "rejects a keypad event that only has the semantic %s key value",
    (actionKey, key, code) => {
      expect(matchesSuggestionActionKey(keyboardEvent({ key, code }), actionKey))
        .toBe(false);
    },
  );

  it("rejects repeat, composition, and non-keydown events", () => {
    expect(matchesSuggestionActionKey(keyboardEvent({
      ...actionKeyCases.tab.event,
      repeat: true,
    }), "tab")).toBe(false);
    expect(matchesSuggestionActionKey(keyboardEvent({
      ...actionKeyCases.tab.event,
      isComposing: true,
    }), "tab")).toBe(false);
    expect(matchesSuggestionActionKey(keyboardEvent({
      ...actionKeyCases.rightShift.event,
      type: "keyup",
    }), "rightShift")).toBe(false);
  });
});

function suggestion(
  id: string,
  location: number,
  length: number,
  overrides: Partial<PresentedSuggestion> = {},
): PresentedSuggestion {
  return {
    id,
    sourceId: "document",
    kind: "grammar",
    attribution: {
      languageDisplayName: "English (American)",
      textDirection: "ltr",
      checkModelDisplayName: "On-Device (Gemma)",
    },
    activationRange: { location, length },
    highlightRanges: [{ location, length }],
    diff: [],
    availableActions: ["apply"],
    ...overrides,
  };
}

function keyboardEvent(
  overrides: Partial<KeyboardEvent> & Pick<KeyboardEvent, "code" | "key">,
): KeyboardEvent {
  return {
    type: "keydown",
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    metaKey: false,
    repeat: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}
