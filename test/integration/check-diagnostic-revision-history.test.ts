import { describe, expect, it, vi } from "vitest";

import {
  captureCheckDiagnosticRevisionMetadata,
  CheckDiagnosticRevisionHistory,
} from "../../src/integration/check-diagnostic-revision-history";
import type { CheckDiagnostics } from "../../src/integration/check-diagnostics";
import type { DocumentSnapshot } from "../../src/integration/types";

const diagnostics: CheckDiagnostics = {
  issues: [{ sourceId: "document", range: { location: 0, length: 1 }, kind: "grammar", reason: "unusableOutput" }],
  omittedIssueCount: 0,
};

function snapshot(revision: string, text = "private writing"): DocumentSnapshot {
  return { revision, sources: [{ sourceId: "document", text, sourceSyntax: "plainText" }] };
}

describe("check diagnostic revision history", () => {
  it("retains only source identity, length, and packed scalar splits", () => {
    const metadata = captureCheckDiagnosticRevisionMetadata({
      revision: "doc:0",
      sources: [
        { sourceId: "document", text: "private😀text𐀀", sourceSyntax: "plainText" },
        { sourceId: "notes", text: "secret", sourceSyntax: "markdownDocument" },
      ],
    }, 1024);

    expect(metadata).toEqual({
      byteLength: 52,
      sources: [
        { sourceId: "document", utf16Length: 15, invalidScalarOffsets: new Uint32Array([8, 14]) },
        { sourceId: "notes", utf16Length: 6, invalidScalarOffsets: new Uint32Array() },
      ],
    });
    expect(JSON.stringify(metadata)).not.toMatch(/private|secret|text|sourceSyntax/);
  });

  it("evicts the oldest revision when the revision budget is exhausted", () => {
    const history = new CheckDiagnosticRevisionHistory(2);
    history.remember(snapshot("doc:0"));
    history.remember(snapshot("doc:1"));
    history.remember(snapshot("doc:2"));

    expect(history.matches(diagnostics, "doc:0", snapshot("doc:0"))).toBe(false);
    expect(history.matches(diagnostics, "doc:1", undefined)).toBe(true);
    expect(history.matches(diagnostics, "doc:2", undefined)).toBe(true);
  });

  it("accounts for revision and source identities and packed offsets in the byte budget", () => {
    // Each revision costs 30 identity/length bytes plus two 4-byte scalar splits.
    const history = new CheckDiagnosticRevisionHistory(64, 75);
    history.remember(snapshot("doc:0", "a😀𐀀"));
    history.remember(snapshot("doc:1", "a😀𐀀"));

    expect(history.matches(diagnostics, "doc:0", undefined)).toBe(false);
    expect(history.matches(diagnostics, "doc:1", undefined)).toBe(true);
  });

  it("fails closed for oversized evidence without evicting usable history", () => {
    const history = new CheckDiagnosticRevisionHistory(64, 32);
    history.remember(snapshot("doc:0"));
    const oversized = snapshot("doc:1", "a😀");
    history.remember(oversized);

    expect(history.matches(diagnostics, "doc:0", undefined)).toBe(true);
    expect(history.matches(diagnostics, "doc:1", oversized)).toBe(false);
    expect(captureCheckDiagnosticRevisionMetadata(oversized, 32)).toBeUndefined();
  });

  it("clears evidence when a coordinator is lost", () => {
    const history = new CheckDiagnosticRevisionHistory();
    history.remember(snapshot("doc:0"));
    history.clear();

    expect(history.matches(diagnostics, "doc:0", undefined)).toBe(false);
    history.remember(snapshot("doc:1"));
    expect(history.matches(diagnostics, "doc:1", undefined)).toBe(true);
  });

  it("does not rescan a retained maximum-size revision on replay or diagnostic events", () => {
    const history = new CheckDiagnosticRevisionHistory();
    const document = snapshot("doc:0", "a".repeat(1_048_572) + "😀");
    history.remember(document);
    const readCodeUnit = vi.spyOn(String.prototype, "charCodeAt");
    try {
      history.remember(document);
      expect(history.matches(diagnostics, document.revision, document)).toBe(true);
      expect(history.matches(diagnostics, document.revision, undefined)).toBe(true);
      expect(readCodeUnit.mock.calls.length).toBeLessThanOrEqual(4);
    } finally {
      readCodeUnit.mockRestore();
    }
  });

  it("packs maximum-size emoji source evidence into its exact budget", () => {
    const document = snapshot("doc:0", "😀".repeat(262_144));
    const byteLength = 1_048_606;
    const metadata = captureCheckDiagnosticRevisionMetadata(document, byteLength);

    expect(metadata?.byteLength).toBe(byteLength);
    expect(metadata?.sources[0]?.invalidScalarOffsets.byteLength).toBe(1_048_576);
    expect(captureCheckDiagnosticRevisionMetadata(document, byteLength - 1)).toBeUndefined();
  });
});
