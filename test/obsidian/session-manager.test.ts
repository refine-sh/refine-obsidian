// @vitest-environment jsdom

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineFaultError } from "../../src/integration/refine-integration";
import type {
  HostApplyRequest,
  HostObservation,
  PresentationSnapshot,
  RefineIntegration,
  SuggestionActions,
  WritingHost,
} from "../../src/integration/types";
import {
  DEFAULT_PRESENTATION_APPEARANCE,
  DEFAULT_PRESENTATION_INTERACTION,
} from "../../src/integration/types";
import {
  ObsidianSessionManager,
  type ObsidianSessionState,
} from "../../src/obsidian/session-manager";
import { IncompatibleProtocolError } from "../../src/transport/refine-transport";

describe("ObsidianSessionManager", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const view of views) {
      view.destroy();
    }
    views.length = 0;
    document.body.replaceChildren();
  });

  it("owns one active editor session and aborts it when the active editor changes", async () => {
    const integration = new RecordingIntegration();
    const manager = new ObsidianSessionManager({ integration });
    const first = createView("first note");
    const second = createView("second note");

    manager.activate(first, first);
    await vi.waitFor(() => expect(integration.runs).toHaveLength(1));
    const firstRun = integration.runs[0];
    expect(firstRun?.signal.aborted).toBe(false);

    manager.activate(second, second);

    expect(firstRun?.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(integration.runs).toHaveLength(2));
    expect(integration.runs[1]?.signal.aborted).toBe(false);

    manager.dispose();
    expect(integration.runs[1]?.signal.aborted).toBe(true);
  });

  it("isolates revisions, Apply, and cleanup across independent windows and vaults", async () => {
    const firstIntegration = new RecordingIntegration();
    const secondIntegration = new RecordingIntegration();
    const firstManager = new ObsidianSessionManager({
      integration: firstIntegration,
    });
    const secondManager = new ObsidianSessionManager({
      integration: secondIntegration,
    });
    const firstView = createView("first vault");
    const secondView = createView("second vault");
    const firstDocument = {};
    const secondDocument = {};

    try {
      firstManager.activate(firstView, firstDocument);
      secondManager.activate(secondView, secondDocument);
      await vi.waitFor(() => {
        expect(firstIntegration.observations[0]?.type).toBe("snapshot");
        expect(secondIntegration.observations[0]?.type).toBe("snapshot");
      });
      const firstRun = firstIntegration.runs[0];
      const secondRun = secondIntegration.runs[0];
      const firstObservation = firstIntegration.observations[0];
      const secondObservation = secondIntegration.observations[0];
      if (
        !firstRun ||
        !secondRun ||
        firstObservation?.type !== "snapshot" ||
        secondObservation?.type !== "snapshot"
      ) {
        throw new Error("expected two independent document snapshots");
      }
      const firstRevision = firstObservation.snapshot.revision;
      const secondRevision = secondObservation.snapshot.revision;
      const firstSessionId = sessionId(firstRevision);
      const secondSessionId = sessionId(secondRevision);
      expect(firstRevision).toBe(`${firstSessionId}:0`);
      expect(secondRevision).toBe(`${secondSessionId}:0`);
      expect(firstSessionId).not.toBe(secondSessionId);

      const firstRequest: HostApplyRequest = {
        expectedRevision: firstRevision,
        sourceId: "document",
        edits: [
          {
            range: { location: 0, length: 5 },
            expectedText: "first",
            replacement: "alpha",
          },
        ],
      };
      const secondRequest: HostApplyRequest = {
        expectedRevision: secondRevision,
        sourceId: "document",
        edits: [
          {
            range: { location: 0, length: 6 },
            expectedText: "second",
            replacement: "beta",
          },
        ],
      };

      await expect(
        secondRun.host.apply({
          ...secondRequest,
          expectedRevision: firstRevision,
        }),
      ).resolves.toEqual({
        status: "rejected",
        reason: "staleRevision",
        snapshot: secondObservation.snapshot,
      });
      expect(firstView.state.doc.toString()).toBe("first vault");
      expect(secondView.state.doc.toString()).toBe("second vault");

      await expect(firstRun.host.apply(firstRequest)).resolves.toEqual({
        status: "applied",
        snapshot: {
          revision: `${firstSessionId}:1`,
          sources: [
            {
              sourceId: "document",
              sourceSyntax: "markdownDocumentHardLineBreaks",
              text: "alpha vault",
            },
          ],
        },
      });
      expect(firstView.state.doc.toString()).toBe("alpha vault");
      expect(secondView.state.doc.toString()).toBe("second vault");

      await expect(secondRun.host.apply(secondRequest)).resolves.toEqual({
        status: "applied",
        snapshot: {
          revision: `${secondSessionId}:1`,
          sources: [
            {
              sourceId: "document",
              sourceSyntax: "markdownDocumentHardLineBreaks",
              text: "beta vault",
            },
          ],
        },
      });
      expect(firstView.state.doc.toString()).toBe("alpha vault");
      expect(secondView.state.doc.toString()).toBe("beta vault");

      await firstRun.host.present(
        completePresentation(`${firstSessionId}:1`),
        inertActions(),
      );
      await secondRun.host.present(
        completePresentation(`${secondSessionId}:1`),
        inertActions(),
      );
      expect(firstView.dom.querySelector(".refine-suggestion")).not.toBeNull();
      expect(secondView.dom.querySelector(".refine-suggestion")).not.toBeNull();

      firstManager.dispose();
      expect(firstRun.signal.aborted).toBe(true);
      expect(secondRun.signal.aborted).toBe(false);
      expect(firstView.dom.querySelector(".refine-suggestion")).toBeNull();
      expect(secondView.dom.querySelector(".refine-suggestion")).not.toBeNull();
      await expect(firstRun.host.apply(firstRequest)).resolves.toEqual({
        status: "unavailable",
      });
      await expect(
        secondRun.host.validateRevision(`${secondSessionId}:1`),
      ).resolves.toEqual({ status: "current" });

      secondManager.dispose();
      expect(secondRun.signal.aborted).toBe(true);
      expect(secondView.dom.querySelector(".refine-suggestion")).toBeNull();
    } finally {
      firstManager.dispose();
      secondManager.dispose();
    }
  });

  it("starts a new document run when Obsidian reuses the active editor view", async () => {
    const states: ObsidianSessionState[] = [];
    const integration = new RecordingIntegration();
    const manager = new ObsidianSessionManager({
      integration,
      onStateChange: (state) => states.push(state),
    });
    const view = createView("first note");
    const firstDocument = {};
    const secondDocument = {};

    manager.activate(view, firstDocument);
    await vi.waitFor(() => expect(integration.runs).toHaveLength(1));
    await vi.waitFor(() => expect(integration.observations).toHaveLength(2));
    const firstRun = integration.runs[0];
    const firstObservation = integration.observations[0];
    if (firstObservation?.type !== "snapshot") {
      throw new Error("expected the first document snapshot");
    }
    await firstRun?.host.present(
      completePresentation(firstObservation.snapshot.revision),
      inertActions(),
    );
    expect(states.at(-1)).toMatchObject({
      type: "presented",
      snapshot: { suggestions: [{ id: "grammar-1" }] },
    });
    expect(view.dom.querySelector(".refine-suggestion")).not.toBeNull();

    manager.activate(view, secondDocument);

    expect(firstRun?.signal.aborted).toBe(true);
    expect(states.at(-1)).toEqual({ type: "starting" });
    expect(view.dom.querySelector(".refine-suggestion")).toBeNull();
    await vi.waitFor(() => expect(integration.runs).toHaveLength(2));
    await vi.waitFor(() =>
      expect(integration.observations).toContainEqual({
        type: "snapshot",
        snapshot: expect.objectContaining({
          sources: [
            {
              sourceId: "document",
              sourceSyntax: "markdownDocumentHardLineBreaks",
              text: "first note",
            },
          ],
        }),
      }),
    );
    expect(integration.runs[1]?.signal.aborted).toBe(false);
    expect(integration.runs[1]?.host).not.toBe(firstRun?.host);

    manager.dispose();
  });

  it("binds an explicit check request to the active editor revision", async () => {
    const integration = new RecordingIntegration();
    const manager = new ObsidianSessionManager({ integration });
    const view = createView("check this note");
    manager.activate(view, view);
    await vi.waitFor(() => expect(integration.observations).toHaveLength(2));

    manager.requestCheck(view, view);

    await vi.waitFor(() => {
      expect(integration.observations).toContainEqual({
        type: "checkRequested",
        revision: expect.stringMatching(/:0$/) as string,
      });
    });
    manager.dispose();
  });

  it("reports inactive and starting host-session lifecycle states", () => {
    const states: ObsidianSessionState[] = [];
    const manager = new ObsidianSessionManager({
      integration: new RecordingIntegration(),
      onStateChange: (state) => states.push(state),
    });
    const view = createView("draft");

    expect(states).toEqual([{ type: "inactive" }]);

    manager.activate(view, view);
    expect(states.at(-1)).toEqual({ type: "starting" });

    manager.deactivate();
    expect(states.at(-1)).toEqual({ type: "inactive" });
  });

  it("forwards the active host's installed presentation", async () => {
    const states: ObsidianSessionState[] = [];
    const integration = new RecordingIntegration();
    const manager = new ObsidianSessionManager({
      integration,
      onStateChange: (state) => states.push(state),
    });
    const view = createView("draft");
    manager.activate(view, view);
    await vi.waitFor(() => expect(integration.observations).toHaveLength(2));
    const observation = integration.observations[0];
    if (observation?.type !== "snapshot") {
      throw new Error("expected an initial snapshot");
    }
    const snapshot = pendingPresentation(observation.snapshot.revision);

    await integration.runs[0]?.host.present(snapshot, inertActions());

    expect(states.at(-1)).toEqual({ type: "presented", snapshot });
    manager.dispose();
  });

  it("suppresses a presentation from a host superseded during installation", async () => {
    const states: ObsidianSessionState[] = [];
    const integration = new RecordingIntegration();
    let switchDuringInstallation = false;
    let manager: ObsidianSessionManager;
    const second = createView("second");
    const first = createView("first", [
      EditorView.updateListener.of(() => {
        if (switchDuringInstallation) {
          switchDuringInstallation = false;
          manager.activate(second, second);
        }
      }),
    ]);
    manager = new ObsidianSessionManager({
      integration,
      onStateChange: (state) => states.push(state),
    });
    manager.activate(first, first);
    await vi.waitFor(() => expect(integration.observations).toHaveLength(2));
    const observation = integration.observations[0];
    if (observation?.type !== "snapshot") {
      throw new Error("expected an initial snapshot");
    }
    states.length = 0;
    switchDuringInstallation = true;

    await integration.runs[0]?.host.present(
      pendingPresentation(observation.snapshot.revision),
      inertActions(),
    );

    expect(states).toEqual([{ type: "starting" }]);
    manager.dispose();
  });

  it("reports a failed state when the active integration run rejects", async () => {
    const failure = new Error("connection rejected");
    const states: ObsidianSessionState[] = [];
    const onError = vi.fn();
    const manager = new ObsidianSessionManager({
      integration: {
        run: async () => {
          throw failure;
        },
      },
      onError,
      onStateChange: (state) => states.push(state),
    });

    const view = createView("draft");
    manager.activate(view, view);

    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual({ type: "failed", reason: "unavailable" }),
    );
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);

    manager.deactivate();
    expect(states.at(-1)).toEqual({ type: "inactive" });
    manager.dispose();
  });

  it("separates a Refine that cannot read the plugin from a Refine that is not running", async () => {
    const states: ObsidianSessionState[] = [];
    const manager = new ObsidianSessionManager({
      integration: {
        run: async () => {
          throw new EngineFaultError("malformedMessage");
        },
      },
      onStateChange: (state) => states.push(state),
    });

    const view = createView("draft");
    manager.activate(view, view);

    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual({
        type: "failed",
        reason: "incompatibleEngine",
      }),
    );
    manager.dispose();
  });

  it("reports an unavailable Refine for a fatal fault it cannot attribute to version skew", async () => {
    const states: ObsidianSessionState[] = [];
    const manager = new ObsidianSessionManager({
      integration: {
        run: async () => {
          throw new EngineFaultError("internalError");
        },
      },
      onStateChange: (state) => states.push(state),
    });

    const view = createView("draft");
    manager.activate(view, view);

    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual({ type: "failed", reason: "unavailable" }),
    );
    manager.dispose();
  });

  it.each([
    { major: 0, minor: 9 },
    { major: 2, minor: 0 },
  ] as const)(
    "reports the exact incompatible protocol versions for %s",
    async (serverProtocol) => {
      const states: ObsidianSessionState[] = [];
      const manager = new ObsidianSessionManager({
        integration: {
          run: async () => {
            throw new IncompatibleProtocolError(serverProtocol);
          },
        },
        onStateChange: (state) => states.push(state),
      });

      const view = createView("draft");
      manager.activate(view, view);

      await vi.waitFor(() =>
        expect(states.at(-1)).toEqual({
          type: "failed",
          reason: "incompatibleProtocol",
          clientProtocol: { major: 1, minor: 0 },
          serverProtocol,
        }),
      );
      manager.dispose();
    },
  );

  it("threads the syntax resolver into the host and forwards declaration changes", async () => {
    const integration = new RecordingIntegration();
    let syntax: "markdownDocument" | "markdownDocumentHardLineBreaks" =
      "markdownDocumentHardLineBreaks";
    const manager = new ObsidianSessionManager({
      integration,
      resolveSourceSyntax: () => syntax,
    });
    const view = createView("Alpha beta.");
    manager.activate(view, {});
    await vi.waitFor(() => {
      expect(integration.observations.length).toBeGreaterThanOrEqual(1);
    });
    expect(integration.observations[0]).toMatchObject({
      type: "snapshot",
      snapshot: {
        sources: [{ sourceSyntax: "markdownDocumentHardLineBreaks" }],
      },
    });

    syntax = "markdownDocument";
    manager.declarationChanged();
    await vi.waitFor(() => {
      expect(
        integration.observations.some(
          (observation) =>
            observation.type === "snapshot" &&
            observation.snapshot.sources[0]?.sourceSyntax ===
              "markdownDocument",
        ),
      ).toBe(true);
    });

    manager.dispose();
  });

  it("ignores a declaration change without an active session", () => {
    const manager = new ObsidianSessionManager({
      integration: new RecordingIntegration(),
    });

    expect(() => manager.declarationChanged()).not.toThrow();

    manager.dispose();
    expect(() => manager.declarationChanged()).not.toThrow();
  });

  function createView(doc: string, extensions: readonly Extension[] = []): EditorView {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions }),
    });
    views.push(view);
    return view;
  }
});

class RecordingIntegration implements RefineIntegration {
  readonly runs: { host: WritingHost; signal: AbortSignal }[] = [];
  readonly observations: HostObservation[] = [];

  async run(input: { host: WritingHost; signal: AbortSignal }): Promise<void> {
    this.runs.push(input);
    for await (const observation of input.host.observe(input.signal)) {
      this.observations.push(observation);
    }
  }
}

function pendingPresentation(revision: string): PresentationSnapshot {
  return {
    documentRevision: revision,
    presentationRevision: 1,
    checkGeneration: 0,
    appearance: DEFAULT_PRESENTATION_APPEARANCE,
    interaction: DEFAULT_PRESENTATION_INTERACTION,
    state: { type: "pending" },
    suggestions: [],
  };
}

function completePresentation(revision: string): PresentationSnapshot {
  return {
    documentRevision: revision,
    presentationRevision: 1,
    checkGeneration: 0,
    appearance: DEFAULT_PRESENTATION_APPEARANCE,
    interaction: DEFAULT_PRESENTATION_INTERACTION,
    state: { type: "complete", coverage: "full" },
    suggestions: [
      {
        id: "grammar-1",
        sourceId: "document",
        kind: "grammar",
        attribution: {
          languageDisplayName: "English (American)",
          textDirection: "ltr",
          checkModelDisplayName: "On-Device (Gemma)",
        },
        activationRange: { location: 0, length: 5 },
        highlightRanges: [{ location: 0, length: 5 }],
        diff: [
          { kind: "delete", text: "first" },
          { kind: "insert", text: "second" },
        ],
        availableActions: ["apply"],
      },
    ],
  };
}

function inertActions(): SuggestionActions {
  return {
    apply: async () => ({ status: "completed" }),
    dismiss: async () => ({ status: "completed" }),
    explain: async function* () {
      return;
    },
    report: async () => ({ status: "completed" }),
  };
}

function sessionId(revision: string): string {
  const separator = revision.lastIndexOf(":");
  if (separator <= 0) {
    throw new Error(`expected session-scoped revision, received ${revision}`);
  }
  return revision.slice(0, separator);
}
