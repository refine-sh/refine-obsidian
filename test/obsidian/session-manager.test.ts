// @vitest-environment jsdom

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HostObservation,
  PresentationSnapshot,
  RefineIntegration,
  SuggestionActions,
  WritingHost,
} from "../../src/integration/types";
import { DEFAULT_PRESENTATION_APPEARANCE } from "../../src/integration/types";
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

    manager.activate(first);
    await vi.waitFor(() => expect(integration.runs).toHaveLength(1));
    const firstRun = integration.runs[0];
    expect(firstRun?.signal.aborted).toBe(false);

    manager.activate(second);

    expect(firstRun?.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(integration.runs).toHaveLength(2));
    expect(integration.runs[1]?.signal.aborted).toBe(false);

    manager.dispose();
    expect(integration.runs[1]?.signal.aborted).toBe(true);
  });

  it("binds an explicit check request to the active editor revision", async () => {
    const integration = new RecordingIntegration();
    const manager = new ObsidianSessionManager({ integration });
    const view = createView("check this note");
    manager.activate(view);
    await vi.waitFor(() => expect(integration.observations).toHaveLength(1));

    manager.requestCheck(view);

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

    manager.activate(view);
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
    manager.activate(view);
    await vi.waitFor(() => expect(integration.observations).toHaveLength(1));
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
          manager.activate(second);
        }
      }),
    ]);
    manager = new ObsidianSessionManager({
      integration,
      onStateChange: (state) => states.push(state),
    });
    manager.activate(first);
    await vi.waitFor(() => expect(integration.observations).toHaveLength(1));
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

    manager.activate(createView("draft"));

    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual({ type: "failed", reason: "unavailable" }),
    );
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);

    manager.deactivate();
    expect(states.at(-1)).toEqual({ type: "inactive" });
    manager.dispose();
  });

  it("reports an incompatible protocol failure explicitly", async () => {
    const states: ObsidianSessionState[] = [];
    const manager = new ObsidianSessionManager({
      integration: {
        run: async () => {
          throw new IncompatibleProtocolError("Refine protocol 1 is incompatible with protocol 2");
        },
      },
      onStateChange: (state) => states.push(state),
    });

    manager.activate(createView("draft"));

    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual({
        type: "failed",
        reason: "incompatibleProtocol",
      }),
    );
    manager.dispose();
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
    appearance: DEFAULT_PRESENTATION_APPEARANCE,
    state: { type: "pending" },
    suggestions: [],
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
