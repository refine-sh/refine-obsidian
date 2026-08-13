// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HostObservation,
  RefineIntegration,
  WritingHost,
} from "../../src/integration/types";
import { ObsidianSessionManager } from "../../src/obsidian/session-manager";

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

  function createView(doc: string): EditorView {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc }),
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
