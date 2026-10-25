// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PRESENTATION_APPEARANCE, DEFAULT_PRESENTATION_INTERACTION, type PresentationSnapshot, type WritingHost } from "../../src/integration/types";
import { partialCheckPassages, partialCheckReport } from "../../src/obsidian/partial-check";
import { ObsidianSessionManager } from "../../src/obsidian/session-manager";
import { statusBarStateForSession } from "../../src/obsidian/status-bar";

function presentation(revision: string): PresentationSnapshot {
  return {
    documentRevision: revision, presentationRevision: 1, checkGeneration: 1,
    appearance: DEFAULT_PRESENTATION_APPEARANCE, interaction: DEFAULT_PRESENTATION_INTERACTION,
    state: { type: "complete", coverage: "partial" }, suggestions: [],
    checkDiagnostics: { issues: [{ sourceId: "document", range: { location: 6, length: 6 }, kind: "grammar", reason: "unusableOutput" }], omittedIssueCount: 2 },
  };
}

describe("partial check details", () => {
  it("shows a passage location and finite reason and exports no writing or identities", () => {
    const snapshot = presentation("PRIVATE_REVISION");
    const document = EditorState.create({ doc: "first\nsecond PRIVATE_WRITING" }).doc;
    const passages = partialCheckPassages(snapshot, document);
    expect(passages[0]?.label).toBe("Line 2 · Grammar: Model response could not be used");
    expect(statusBarStateForSession({ type: "presented", snapshot })).toMatchObject({ type: "partial", uncheckedPassageCount: 3 });
    const report = partialCheckReport(snapshot, document);
    expect(JSON.parse(report)).toEqual({ schema: 1, status: "partial", suggestionCount: 0, omittedIssueCount: 2,
      issues: [{ firstLine: 2, lastLine: 2, kind: "grammar", reason: "unusableOutput" }] });
    expect(report).not.toContain("PRIVATE");
    expect(report).not.toContain("sourceId");
  });

  it.each(["current", "edited", "editedDuringValidation", "superseded", "deactivated"] as const)(
    "navigates only the current presentation (%s)", async (condition) => {
      let host: WritingHost | undefined;
      let revision: string | undefined;
      const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: "first\nsecond line" }) });
      const manager = new ObsidianSessionManager({ integration: { run: async (options) => {
        host = options.host;
        for await (const observation of host.observe(options.signal)) {
          if (observation.type === "snapshot") revision = observation.snapshot.revision;
        }
      } } });
      try {
        manager.activate(view, view);
        await vi.waitFor(() => expect(revision).toBeDefined());
        const snapshot = presentation(revision!);
        const actions = { apply: vi.fn(), dismiss: vi.fn(), explain: vi.fn(), report: vi.fn() };
        await host!.present(snapshot, actions);
        if (condition === "edited") view.dispatch({ changes: { from: 0, insert: "new " } });
        if (condition === "superseded") await host!.present({ ...snapshot, presentationRevision: 2 }, actions);
        if (condition === "deactivated") manager.deactivate();
        const navigation = manager.revealCheckIssue(snapshot, snapshot.checkDiagnostics!.issues[0]!);
        if (condition === "editedDuringValidation") view.dispatch({ changes: { from: 0, insert: "new " } });
        expect(await navigation).toBe(condition === "current");
        if (condition === "current") expect(view.state.selection.main).toMatchObject({ from: 6, to: 12 });
      } finally { manager.dispose(); view.destroy(); document.body.replaceChildren(); }
    },
  );
});
