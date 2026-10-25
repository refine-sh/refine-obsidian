import { describe, expect, it, vi } from "vitest";

import {
  checkDiagnosticsMatchSnapshot,
  type CheckDiagnostics,
} from "../../src/integration/check-diagnostics";
import type { DocumentSnapshot, UTF16Range } from "../../src/integration/types";

function diagnostics(range: UTF16Range): CheckDiagnostics {
  return {
    issues: [{ sourceId: "document", range, kind: "grammar", reason: "unusableOutput" }],
    omittedIssueCount: 0,
  };
}

function snapshot(text: string): DocumentSnapshot {
  return {
    revision: "doc:0",
    sources: [{ sourceId: "document", text, sourceSyntax: "plainText" }],
  };
}

describe("diagnostic source validation", () => {
  it.each([
    [{ location: 0, length: 1 }, true],
    [{ location: 1, length: 2 }, true],
    [{ location: 3, length: 1 }, true],
    [{ location: 4, length: 1 }, true],
    [{ location: 5, length: 2 }, true],
    [{ location: 0, length: 7 }, true],
    [{ location: 2, length: 1 }, false],
    [{ location: 1, length: 1 }, false],
    [{ location: 5, length: 1 }, false],
    [{ location: 6, length: 1 }, false],
    [{ location: 7, length: 1 }, false],
    [{ location: -1, length: 1 }, false],
    [{ location: 0.5, length: 0.5 }, false],
    [{ location: 0, length: 0 }, false],
    [{ location: Number.MAX_SAFE_INTEGER, length: 1 }, false],
  ] as const)("validates scalar endpoints for %j", (range, valid) => {
    expect(checkDiagnosticsMatchSnapshot(diagnostics(range), snapshot("A😀e\u0301𐀀"))).toBe(valid);
  });

  it("validates diagnostic endpoints without traversing a maximum-size note", () => {
    const text = "a".repeat(1_048_572) + "😀";
    const document = snapshot(text);
    const valid = diagnostics({ location: text.length - 2, length: 2 });
    const invalid = diagnostics({ location: text.length - 1, length: 1 });
    const iterateText = vi.spyOn(String.prototype, Symbol.iterator);
    try {
      expect(checkDiagnosticsMatchSnapshot(valid, document)).toBe(true);
      expect(checkDiagnosticsMatchSnapshot(invalid, document)).toBe(false);
      expect(iterateText).not.toHaveBeenCalled();
    } finally {
      iterateText.mockRestore();
    }
  });
});
