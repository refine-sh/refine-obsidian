import { describe, expect, it, vi } from "vitest";

import { createRefineIntegration } from "../../src/integration/refine-integration";
import { DEFAULT_PRESENTATION_APPEARANCE } from "../../src/integration/types";
import type {
  DocumentSnapshot,
  HostApplyOutcome,
  HostApplyRequest,
  HostObservation,
  HostRevisionValidation,
  PresentationSnapshot,
  SuggestionActions,
  WritingHost,
} from "../../src/integration/types";
import type { PresentationAppearance } from "../../src/integration/types";
import { AsyncQueue } from "../../src/shared/async-queue";
import type {
  CommandReceipt,
  RefineTransportSession,
} from "../../src/transport/refine-transport";
import type {
  ClientCommand,
  ServerEventEnvelope,
} from "../../src/transport/wire";

describe("RefineIntegration", () => {
  it("opens canonical source, presents engine results, and completes Apply exactly once", async () => {
    const host = new FakeHost(snapshot("doc:0", "[create an link](URL)or"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });

    await vi.waitFor(() =>
      expect(engine.commands[0]?.command).toEqual({
        type: "openDocument",
        snapshot: snapshot("doc:0", "[create an link](URL)or"),
      }),
    );

    engine.emit({
      type: "presentationContentReplaced",
      checkId: "check-1",
      content: {
        documentRevision: "doc:0",
        status: "complete",
        coverage: "full",
        appearance: DEFAULT_PRESENTATION_APPEARANCE,
        suggestions: [
          {
            id: "suggestion-1",
            sourceId: "document",
            kind: "grammar",
            highlightRanges: [{ location: 8, length: 2 }],
            diff: [
              { kind: "delete", text: "an" },
              { kind: "insert", text: "a" },
            ],
            availableActions: ["apply"],
          },
        ],
      },
    });
    await vi.waitFor(() => expect(host.currentPresentation?.suggestions).toHaveLength(1));

    const action = host.currentActions?.apply("suggestion-1");
    if (!action) {
      throw new Error("expected Apply action");
    }
    await vi.waitFor(() =>
      expect(engine.commands.some(({ command }) => command.type === "performAction")).toBe(true),
    );
    const perform = engine.commands.find(
      ({ command }) => command.type === "performAction",
    )?.command;
    if (!perform || perform.type !== "performAction") {
      throw new Error("expected performAction command");
    }

    const request: HostApplyRequest = {
      expectedRevision: "doc:0",
      sourceId: "document",
      edits: [
        {
          range: { location: 21, length: 0 },
          expectedText: "",
          replacement: " ",
        },
        {
          range: { location: 8, length: 2 },
          expectedText: "an",
          replacement: "a",
        },
      ],
    };
    engine.emit({
      type: "applyRequested",
      actionId: perform.actionId,
      transactionId: "transaction-1",
      request,
    });
    engine.emit({
      type: "applyRequested",
      actionId: perform.actionId,
      transactionId: "transaction-1",
      request,
    });

    await vi.waitFor(() => {
      expect(host.apply).toHaveBeenCalledTimes(1);
      expect(
        engine.commands.filter(({ command }) => command.type === "completeApply"),
      ).toHaveLength(2);
    });
    engine.emit({ type: "actionCompleted", actionId: perform.actionId });
    await expect(action).resolves.toEqual({ status: "completed" });

    controller.abort();
    host.observations.close();
    await run;
    expect(engine.commands.at(-1)?.command).toEqual({ type: "closeDocument" });
  });

  it("clears old suggestions before sending a changed Markdown snapshot", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));

    engine.emit({
      type: "presentationContentReplaced",
      checkId: "check-1",
      content: {
        documentRevision: "doc:0",
        status: "complete",
        coverage: "full",
        appearance: DEFAULT_PRESENTATION_APPEARANCE,
        suggestions: [
          {
            id: "old",
            sourceId: "document",
            kind: "grammar",
            highlightRanges: [{ location: 7, length: 2 }],
            diff: [],
            availableActions: ["apply"],
          },
        ],
      },
    });
    await vi.waitFor(() => expect(host.currentPresentation?.suggestions).toHaveLength(1));

    host.observations.push({
      type: "snapshot",
      snapshot: snapshot("doc:1", "create a link"),
    });

    await vi.waitFor(() => {
      expect(host.currentPresentation).toMatchObject({
        documentRevision: "doc:1",
        state: { type: "pending" },
        suggestions: [],
      });
      expect(engine.commands.at(-1)?.command).toEqual({
        type: "replaceDocument",
        snapshot: snapshot("doc:1", "create a link"),
      });
    });

    engine.emit({
      type: "presentationContentReplaced",
      checkId: "obsolete-check",
      content: {
        documentRevision: "doc:0",
        status: "complete",
        coverage: "full",
        appearance: DEFAULT_PRESENTATION_APPEARANCE,
        suggestions: [],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.currentPresentation?.documentRevision).toBe("doc:1");

    controller.abort();
    host.observations.close();
    await run;
  });

  it("retains the latest engine appearance across locally synthesized presentations", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));
    expect(host.currentPresentation?.appearance).toEqual(DEFAULT_PRESENTATION_APPEARANCE);

    engine.emit({
      type: "presentationContentReplaced",
      checkId: "check-appearance",
      content: {
        documentRevision: "doc:0",
        status: "complete",
        coverage: "full",
        appearance: alternateAppearance,
        suggestions: [],
      },
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.appearance).toEqual(alternateAppearance),
    );

    host.observations.push({
      type: "snapshot",
      snapshot: snapshot("doc:1", "create a link"),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation).toMatchObject({
        documentRevision: "doc:1",
        state: { type: "pending" },
        appearance: alternateAppearance,
      }),
    );

    controller.abort();
    host.observations.close();
    await run;
    expect(host.currentPresentation).toMatchObject({
      state: { type: "closed" },
      appearance: alternateAppearance,
    });
  });

  it("re-presents a current check when only its appearance changes", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));
    const first = suggestionPresentation("check-appearance", "suggestion-1");
    engine.emit(first);
    await vi.waitFor(() => expect(host.currentPresentation?.suggestions).toHaveLength(1));
    const firstRevision = host.currentPresentation?.presentationRevision ?? 0;

    engine.emit({
      ...first,
      content: { ...first.content, appearance: alternateAppearance },
    });

    await vi.waitFor(() => {
      expect(host.currentPresentation?.appearance).toEqual(alternateAppearance);
      expect(host.currentPresentation?.presentationRevision).toBeGreaterThan(firstRevision);
      expect(host.currentPresentation?.suggestions[0]?.id).toBe("suggestion-1");
    });

    controller.abort();
    host.observations.close();
    await run;
  });

  it("reconnects with the latest full snapshot after the engine connection closes", async () => {
    const host = new FakeHost(snapshot("doc:0", "first"));
    const engine = new ReconnectingEngine();
    const integration = createRefineIntegration({ enginePort: engine, reconnectDelayMs: 0 });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.sessions[0]?.commands).toHaveLength(1));

    host.observations.push({
      type: "snapshot",
      snapshot: snapshot("doc:1", "latest"),
    });
    await vi.waitFor(() =>
      expect(engine.sessions[0]?.commands.at(-1)?.command).toEqual({
        type: "replaceDocument",
        snapshot: snapshot("doc:1", "latest"),
      }),
    );
    engine.sessions[0]?.events.close();

    await vi.waitFor(() => {
      expect(engine.sessions).toHaveLength(2);
      expect(engine.sessions[1]?.commands[0]?.command).toEqual({
        type: "openDocument",
        snapshot: snapshot("doc:1", "latest"),
      });
      expect(host.presentations).toContainEqual(
        expect.objectContaining({ state: { type: "unavailable", reason: "disconnected" } }),
      );
    });

    controller.abort();
    host.observations.close();
    engine.sessions[1]?.events.close();
    await run;
  });

  it("reopens once on the same session when Refine has no open document", async () => {
    const host = new FakeHost(snapshot("doc:0", "first"));
    const engine = new ReconnectingEngine();
    const integration = createRefineIntegration({ enginePort: engine, reconnectDelayMs: 0 });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.sessions[0]?.commands).toHaveLength(1));

    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      event: { type: "resyncRequired", reason: "documentNotOpen" },
    });

    await vi.waitFor(() => {
      expect(engine.sessions).toHaveLength(1);
      expect(engine.sessions[0]?.commands[1]?.command).toEqual({
        type: "openDocument",
        snapshot: snapshot("doc:0", "first"),
      });
    });

    controller.abort();
    host.observations.close();
    engine.sessions[0]?.events.close();
    await run;
  });

  it("fails closed instead of looping when Refine rejects a conflicting revision", async () => {
    const host = new FakeHost(snapshot("doc:0", "first"));
    const engine = new ReconnectingEngine();
    const integration = createRefineIntegration({ enginePort: engine, reconnectDelayMs: 0 });
    const run = integration.run({ host, signal: new AbortController().signal });
    await vi.waitFor(() => expect(engine.sessions[0]?.commands).toHaveLength(1));

    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      event: { type: "resyncRequired", reason: "conflictingRevision" },
    });

    await expect(run).rejects.toThrow("conflictingRevision");
    expect(engine.sessions).toHaveLength(1);
    expect(engine.sessions[0]?.commands.map(({ command }) => command.type)).toEqual([
      "openDocument",
      "closeDocument",
    ]);
  });

  it("rejects a retired revision without retaining old document text", async () => {
    const host = new FakeHost(snapshot("doc:0", "first"));
    const engine = new ReconnectingEngine();
    const integration = createRefineIntegration({ enginePort: engine, reconnectDelayMs: 0 });
    const run = integration.run({ host, signal: new AbortController().signal });
    await vi.waitFor(() => expect(engine.sessions[0]?.commands).toHaveLength(1));

    host.currentSnapshot = snapshot("doc:1", "second");
    host.observations.push({ type: "snapshot", snapshot: host.currentSnapshot });
    await vi.waitFor(() =>
      expect(engine.sessions[0]?.commands.at(-1)?.command).toEqual({
        type: "replaceDocument",
        snapshot: snapshot("doc:1", "second"),
      }),
    );

    host.currentSnapshot = snapshot("doc:0", "first");
    host.observations.push({ type: "snapshot", snapshot: host.currentSnapshot });

    await expect(run).rejects.toThrow("reused a retired revision");
  });

  it("replays a manual check after reconnect until its terminal presentation arrives", async () => {
    const host = new FakeHost(snapshot("doc:0", "first"));
    const engine = new ReconnectingEngine();
    const integration = createRefineIntegration({ enginePort: engine, reconnectDelayMs: 0 });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.sessions[0]?.commands).toHaveLength(1));

    host.observations.push({ type: "checkRequested", revision: "doc:0" });
    await vi.waitFor(() =>
      expect(engine.sessions[0]?.commands.at(-1)?.command).toEqual({
        type: "requestCheck",
        revision: "doc:0",
      }),
    );
    engine.sessions[0]?.events.close();

    await vi.waitFor(() => {
      expect(engine.sessions).toHaveLength(2);
      expect(engine.sessions[1]?.commands.map(({ command }) => command.type)).toEqual([
        "openDocument",
        "requestCheck",
      ]);
    });

    controller.abort();
    host.observations.close();
    engine.sessions[1]?.events.close();
    await run;
  });

  it("publishes a failed check distinctly and accepts a manual retry", async () => {
    const host = new FakeHost(snapshot("doc:0", "first"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));

    host.observations.push({ type: "checkRequested", revision: "doc:0" });
    await vi.waitFor(() =>
      expect(
        engine.commands.filter(({ command }) => command.type === "requestCheck"),
      ).toHaveLength(1),
    );
    const firstRequest = engine.commands.find(
      ({ command }) => command.type === "requestCheck",
    );
    if (!firstRequest) {
      throw new Error("expected initial requestCheck command");
    }
    engine.eventQueue.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      causeCommandId: firstRequest.id,
      event: {
        type: "presentationContentReplaced",
        checkId: "check-failed",
        content: {
          documentRevision: "doc:0",
          status: "unavailable",
          unavailableReason: "checkFailed",
          appearance: DEFAULT_PRESENTATION_APPEARANCE,
          suggestions: [],
        },
      },
    });
    engine.eventQueue.push({
      type: "event",
      sequence: 2,
      epoch: "epoch-1",
      causeCommandId: firstRequest.id,
      event: {
        type: "fault",
        code: "internalError",
        fatal: false,
      },
    });

    await vi.waitFor(() =>
      expect(host.currentPresentation).toMatchObject({
        state: { type: "unavailable", reason: "checkFailed" },
        suggestions: [],
      }),
    );

    host.observations.push({ type: "checkRequested", revision: "doc:0" });
    await vi.waitFor(() =>
      expect(
        engine.commands.filter(({ command }) => command.type === "requestCheck"),
      ).toHaveLength(2),
    );

    controller.abort();
    host.observations.close();
    await run;
  });

  it("publishes a standalone engine-unavailable fault as unavailable", async () => {
    const host = new FakeHost(snapshot("doc:0", "first"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));

    engine.emit({
      type: "fault",
      code: "engineUnavailable",
      fatal: false,
    });

    await vi.waitFor(() =>
      expect(host.currentPresentation).toMatchObject({
        state: { type: "unavailable", reason: "engineUnavailable" },
        suggestions: [],
      }),
    );

    controller.abort();
    host.observations.close();
    await run;
  });

  it("replays only an Apply receipt after reconnect and never repeats the host mutation", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new ReconnectingEngine();
    const integration = createRefineIntegration({ enginePort: engine, reconnectDelayMs: 0 });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.sessions[0]?.commands).toHaveLength(1));

    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      event: suggestionPresentation("check-1", "suggestion-1"),
    });
    await vi.waitFor(() => expect(host.currentPresentation?.suggestions).toHaveLength(1));
    const apply = host.currentActions?.apply("suggestion-1");
    if (!apply) {
      throw new Error("expected Apply action");
    }
    await vi.waitFor(() =>
      expect(engine.sessions[0]?.commands.at(-1)?.command.type).toBe("performAction"),
    );
    const perform = engine.sessions[0]?.commands.at(-1)?.command;
    if (!perform || perform.type !== "performAction") {
      throw new Error("expected performAction command");
    }
    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 2,
      epoch: "epoch-1",
      event: {
        type: "applyRequested",
        actionId: perform.actionId,
        transactionId: "transaction-1",
        request: {
          expectedRevision: "doc:0",
          sourceId: "document",
          edits: [
            {
              range: { location: 7, length: 2 },
              expectedText: "an",
              replacement: "a",
            },
          ],
        },
      },
    });
    await vi.waitFor(() =>
      expect(engine.sessions[0]?.commands.at(-1)?.command.type).toBe("completeApply"),
    );
    engine.sessions[0]?.events.close();

    await vi.waitFor(() => expect(engine.sessions).toHaveLength(2));
    expect(host.apply).toHaveBeenCalledTimes(1);
    expect(engine.sessions[1]?.commands.map(({ command }) => command.type)).toEqual([
      "completeApply",
      "openDocument",
    ]);
    engine.sessions[1]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      event: { type: "actionCompleted", actionId: perform.actionId },
    });
    await expect(apply).resolves.toEqual({ status: "completed" });

    controller.abort();
    host.observations.close();
    engine.sessions[1]?.events.close();
    await run;
  });

  it.each([
    {
      name: "Refine restarted with a new server epoch",
      epochs: ["epoch-1", "epoch-2"],
      resumed: [false, false],
    },
    {
      name: "Refine no longer retains the run in the same server epoch",
      epochs: ["epoch-1", "epoch-1"],
      resumed: [false, false],
    },
  ])("drops an unacknowledged receipt when $name", async ({ epochs, resumed }) => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new ReconnectingEngine(epochs, resumed);
    const integration = createRefineIntegration({ enginePort: engine, reconnectDelayMs: 0 });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.sessions[0]?.commands).toHaveLength(1));

    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      event: suggestionPresentation("check-1", "suggestion-1"),
    });
    await vi.waitFor(() => expect(host.currentPresentation?.suggestions).toHaveLength(1));
    const apply = host.currentActions?.apply("suggestion-1");
    if (!apply) {
      throw new Error("expected Apply action");
    }
    await vi.waitFor(() =>
      expect(engine.sessions[0]?.commands.at(-1)?.command.type).toBe("performAction"),
    );
    const perform = engine.sessions[0]?.commands.at(-1)?.command;
    if (!perform || perform.type !== "performAction") {
      throw new Error("expected performAction command");
    }
    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 2,
      epoch: "epoch-1",
      event: {
        type: "applyRequested",
        actionId: perform.actionId,
        transactionId: "transaction-1",
        request: {
          expectedRevision: "doc:0",
          sourceId: "document",
          edits: [
            {
              range: { location: 7, length: 2 },
              expectedText: "an",
              replacement: "a",
            },
          ],
        },
      },
    });
    await vi.waitFor(() =>
      expect(engine.sessions[0]?.commands.at(-1)?.command.type).toBe("completeApply"),
    );
    engine.sessions[0]?.events.close();

    await vi.waitFor(() => expect(engine.sessions).toHaveLength(2));
    await expect(apply).resolves.toEqual({ status: "unavailable", reason: "disconnected" });
    expect(host.apply).toHaveBeenCalledTimes(1);
    expect(engine.sessions[1]?.commands.map(({ command }) => command.type)).toEqual([
      "openDocument",
    ]);

    controller.abort();
    host.observations.close();
    engine.sessions[1]?.events.close();
    await run;
  });

  it("clears Apply and refreshes host observation after an indeterminate mutation", async () => {
    const host = new RestartableFakeHost(snapshot("doc:0", "create an link"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));

    engine.emit(suggestionPresentation("check-1", "suggestion-1"));
    await vi.waitFor(() => expect(host.currentPresentation?.suggestions).toHaveLength(1));
    const apply = host.currentActions?.apply("suggestion-1");
    if (!apply) {
      throw new Error("expected Apply action");
    }
    await vi.waitFor(() =>
      expect(engine.commands.at(-1)?.command.type).toBe("performAction"),
    );
    const perform = engine.commands.at(-1)?.command;
    if (!perform || perform.type !== "performAction") {
      throw new Error("expected performAction command");
    }

    engine.emit({
      type: "applyRequested",
      actionId: perform.actionId,
      transactionId: "indeterminate-transaction",
      request: {
        expectedRevision: "doc:0",
        sourceId: "document",
        edits: [
          {
            range: { location: 7, length: 2 },
            expectedText: "an",
            replacement: "a",
          },
        ],
      },
    });

    await vi.waitFor(() => {
      expect(host.observationCount).toBe(2);
      expect(engine.commands.at(-1)?.command).toMatchObject({
        type: "completeApply",
        transactionId: "indeterminate-transaction",
        outcome: { status: "indeterminate" },
      });
      expect(host.currentPresentation?.suggestions).toEqual([]);
    });
    engine.emit({
      type: "actionRejected",
      actionId: perform.actionId,
      reason: "mutationIndeterminate",
    });
    await expect(apply).resolves.toEqual({
      status: "unavailable",
      reason: "mutationIndeterminate",
    });
    await expect(host.currentActions?.apply("suggestion-1")).resolves.toEqual({
      status: "stale",
    });
    expect(host.apply).toHaveBeenCalledTimes(1);

    controller.abort();
    await run;
  });

  it("receipts Apply readback before forwarding a later observed revision", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    let finishApply: ((outcome: HostApplyOutcome) => void) | undefined;
    host.apply.mockImplementationOnce(
      () => new Promise<HostApplyOutcome>((resolve) => {
        finishApply = resolve;
      }),
    );
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));
    engine.emit(suggestionPresentation("check-1", "suggestion-1"));
    await vi.waitFor(() => expect(host.currentPresentation?.suggestions).toHaveLength(1));
    const apply = host.currentActions?.apply("suggestion-1");
    if (!apply) {
      throw new Error("expected Apply action");
    }
    await vi.waitFor(() =>
      expect(engine.commands.at(-1)?.command.type).toBe("performAction"),
    );
    const perform = engine.commands.at(-1)?.command;
    if (!perform || perform.type !== "performAction") {
      throw new Error("expected performAction command");
    }
    engine.emit({
      type: "applyRequested",
      actionId: perform.actionId,
      transactionId: "ordered-transaction",
      request: {
        expectedRevision: "doc:0",
        sourceId: "document",
        edits: [
          {
            range: { location: 7, length: 2 },
            expectedText: "an",
            replacement: "a",
          },
        ],
      },
    });
    await vi.waitFor(() => expect(host.apply).toHaveBeenCalledTimes(1));

    const later = snapshot("doc:2", "create a link!");
    host.currentSnapshot = later;
    host.observations.push({ type: "snapshot", snapshot: later });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.documentRevision).toBe("doc:2"),
    );
    finishApply?.({
      status: "applied",
      snapshot: snapshot("doc:1", "create a link"),
    });

    await vi.waitFor(() =>
      expect(engine.commands.slice(-2).map(({ command }) => command.type)).toEqual([
        "completeApply",
        "replaceDocument",
      ]),
    );
    expect(engine.commands.at(-1)?.command).toEqual({
      type: "replaceDocument",
      snapshot: later,
    });
    engine.emit({ type: "actionCompleted", actionId: perform.actionId });
    await expect(apply).resolves.toEqual({ status: "completed" });

    controller.abort();
    host.observations.close();
    await run;
  });

  it("does not send a superseded same-revision action after validation", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    let finishValidation: ((result: HostRevisionValidation) => void) | undefined;
    host.validateRevision.mockImplementationOnce(
      () => new Promise<HostRevisionValidation>((resolve) => {
        finishValidation = resolve;
      }),
    );
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));
    engine.emit({
      ...suggestionPresentation("check-1", "suggestion-1"),
      content: {
        ...suggestionPresentation("check-1", "suggestion-1").content,
        suggestions: [
          {
            ...suggestionPresentation("check-1", "suggestion-1").content.suggestions[0]!,
            availableActions: ["dismiss"],
          },
        ],
      },
    });
    await vi.waitFor(() => expect(host.currentPresentation?.suggestions).toHaveLength(1));
    const dismiss = host.currentActions?.dismiss("suggestion-1");
    if (!dismiss) {
      throw new Error("expected Dismiss action");
    }
    await vi.waitFor(() => expect(host.validateRevision).toHaveBeenCalledTimes(1));

    engine.emit({
      type: "presentationContentReplaced",
      checkId: "check-2",
      content: {
        documentRevision: "doc:0",
        status: "complete",
        coverage: "full",
        appearance: DEFAULT_PRESENTATION_APPEARANCE,
        suggestions: [],
      },
    });
    await vi.waitFor(() => expect(host.currentPresentation?.suggestions).toEqual([]));
    finishValidation?.({ status: "current" });

    await expect(dismiss).resolves.toEqual({ status: "stale" });
    expect(
      engine.commands.filter(({ command }) => command.type === "performAction"),
    ).toEqual([]);

    controller.abort();
    host.observations.close();
    await run;
  });

  it("removes a completed dismissal from native presentation", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));
    engine.emit({
      type: "presentationContentReplaced",
      checkId: "check-1",
      content: {
        documentRevision: "doc:0",
        status: "complete",
        coverage: "full",
        appearance: DEFAULT_PRESENTATION_APPEARANCE,
        suggestions: [
          {
            id: "dismiss-me",
            sourceId: "document",
            kind: "grammar",
            highlightRanges: [{ location: 7, length: 2 }],
            diff: [],
            availableActions: ["apply", "dismiss"],
          },
        ],
      },
    });
    await vi.waitFor(() => expect(host.currentPresentation?.suggestions).toHaveLength(1));

    const dismissal = host.currentActions?.dismiss("dismiss-me");
    if (!dismissal) {
      throw new Error("expected Dismiss action");
    }
    await vi.waitFor(() =>
      expect(engine.commands.some(({ command }) => command.type === "performAction")).toBe(true),
    );
    const perform = engine.commands.find(
      ({ command }) => command.type === "performAction",
    )?.command;
    if (!perform || perform.type !== "performAction") {
      throw new Error("expected performAction command");
    }
    engine.emit({ type: "actionCompleted", actionId: perform.actionId });

    await expect(dismissal).resolves.toEqual({ status: "completed" });
    await vi.waitFor(() => expect(host.currentPresentation?.suggestions).toEqual([]));

    controller.abort();
    host.observations.close();
    await run;
  });

  it("rejects a late Apply request after a newer check supersedes its suggestion", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));
    engine.emit(suggestionPresentation("check-1", "old-suggestion"));
    await vi.waitFor(() => expect(host.currentPresentation?.suggestions).toHaveLength(1));

    const apply = host.currentActions?.apply("old-suggestion");
    if (!apply) {
      throw new Error("expected Apply action");
    }
    await vi.waitFor(() =>
      expect(engine.commands.some(({ command }) => command.type === "performAction")).toBe(true),
    );
    const perform = engine.commands.find(
      ({ command }) => command.type === "performAction",
    )?.command;
    if (!perform || perform.type !== "performAction") {
      throw new Error("expected performAction command");
    }

    engine.emit({
      type: "presentationContentReplaced",
      checkId: "check-2",
      content: {
        documentRevision: "doc:0",
        status: "complete",
        coverage: "full",
        appearance: DEFAULT_PRESENTATION_APPEARANCE,
        suggestions: [],
      },
    });
    await expect(apply).resolves.toEqual({ status: "stale" });

    engine.emit({
      type: "applyRequested",
      actionId: perform.actionId,
      transactionId: "late-transaction",
      request: {
        expectedRevision: "doc:0",
        sourceId: "document",
        edits: [
          {
            range: { location: 7, length: 2 },
            expectedText: "an",
            replacement: "a",
          },
        ],
      },
    });
    await vi.waitFor(() => {
      expect(host.apply).not.toHaveBeenCalled();
      expect(engine.commands.at(-1)?.command).toMatchObject({
        type: "completeApply",
        transactionId: "late-transaction",
        outcome: { status: "rejected", reason: "staleRevision" },
      });
    });

    controller.abort();
    host.observations.close();
    await run;
  });

  it("keeps Apply disabled across progressive replacements from the same check", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));
    engine.emit(suggestionPresentation("check-1", "suggestion-1"));
    await vi.waitFor(() => expect(host.currentPresentation?.suggestions).toHaveLength(1));

    const apply = host.currentActions?.apply("suggestion-1");
    if (!apply) {
      throw new Error("expected Apply action");
    }
    await vi.waitFor(() =>
      expect(host.currentPresentation?.suggestions[0]?.availableActions).toEqual([]),
    );

    engine.emit(suggestionPresentation("check-1", "suggestion-1"));

    await vi.waitFor(() =>
      expect(host.currentPresentation?.suggestions[0]?.availableActions).toEqual([]),
    );

    controller.abort();
    host.observations.close();
    await expect(apply).resolves.toEqual({ status: "stale" });
    await run;
  });

  it("preserves an in-flight Apply when settings regroup its semantic edits", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    host.apply.mockResolvedValueOnce({ status: "unsupported", reason: "readOnly" });
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));
    engine.emit(suggestionPresentation("check-1", "word-suggestion"));
    await vi.waitFor(() => expect(host.currentPresentation?.suggestions).toHaveLength(1));

    const originalApply = host.currentActions?.apply("word-suggestion");
    if (!originalApply) {
      throw new Error("expected Apply action");
    }
    await vi.waitFor(() =>
      expect(engine.commands.at(-1)?.command.type).toBe("performAction"),
    );
    const perform = engine.commands.at(-1)?.command;
    if (!perform || perform.type !== "performAction") {
      throw new Error("expected performAction command");
    }
    const regrouped = suggestionPresentation("check-1", "sentence-suggestion");
    engine.emit({
      ...regrouped,
      content: {
        ...regrouped.content,
        suggestions: regrouped.content.suggestions.map((suggestion) => ({
          ...suggestion,
          availableActions: [],
        })),
      },
    });
    await vi.waitFor(() => {
      expect(host.currentPresentation?.suggestions[0]).toMatchObject({
        id: "sentence-suggestion",
        availableActions: [],
      });
    });

    await expect(
      host.currentActions?.apply("sentence-suggestion"),
    ).resolves.toEqual({ status: "stale" });
    expect(
      engine.commands.filter(({ command }) => command.type === "performAction"),
    ).toHaveLength(1);

    engine.emit({
      type: "applyRequested",
      actionId: perform.actionId,
      transactionId: "settings-transaction",
      request: {
        expectedRevision: "doc:0",
        sourceId: "document",
        edits: [
          {
            range: { location: 7, length: 2 },
            expectedText: "an",
            replacement: "a",
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(engine.commands.at(-1)?.command).toMatchObject({
        type: "completeApply",
        transactionId: "settings-transaction",
      }),
    );
    engine.emit({
      type: "actionRejected",
      actionId: perform.actionId,
      reason: "readOnly",
    });
    await expect(originalApply).resolves.toEqual({
      status: "unavailable",
      reason: "readOnly",
    });

    engine.emit(suggestionPresentation("check-1", "sentence-suggestion"));
    await vi.waitFor(() =>
      expect(host.currentPresentation?.suggestions[0]?.availableActions).toEqual(["apply"]),
    );
    expect(host.apply).toHaveBeenCalledTimes(1);

    controller.abort();
    host.observations.close();
    await run;
  });
});

const alternateAppearance: PresentationAppearance = {
  highlight: {
    style: "dashedUnderline",
    grammarColor: "#AABBCC",
    fluencyColor: "#DDEEFF",
  },
  diff: {
    additionColor: "#123456",
    deletionColor: "#ABCDEF",
    showHiddenWhitespace: false,
  },
};

class FakeHost implements WritingHost {
  readonly observations = new AsyncQueue<HostObservation>();
  currentPresentation: PresentationSnapshot | undefined;
  currentActions: SuggestionActions | undefined;
  readonly presentations: PresentationSnapshot[] = [];
  currentSnapshot: DocumentSnapshot;
  readonly apply = vi.fn(async (_request: HostApplyRequest): Promise<HostApplyOutcome> => {
    this.currentSnapshot = snapshot("doc:1", "[create a link](URL) or");
    return { status: "applied", snapshot: this.currentSnapshot };
  });

  constructor(initial: DocumentSnapshot) {
    this.currentSnapshot = initial;
    this.observations.push({ type: "snapshot", snapshot: initial });
  }

  async *observe(signal: AbortSignal): AsyncIterable<HostObservation> {
    const abort = (): void => this.observations.close();
    signal.addEventListener("abort", abort, { once: true });
    try {
      yield* this.observations;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  readonly validateRevision = vi.fn(
    (revision: string): Promise<HostRevisionValidation> => Promise.resolve(
      revision === this.currentSnapshot.revision
        ? { status: "current" }
        : { status: "stale", snapshot: this.currentSnapshot },
    ),
  );

  present(snapshot: PresentationSnapshot, actions: SuggestionActions): void {
    this.presentations.push(snapshot);
    this.currentPresentation = snapshot;
    this.currentActions = actions;
  }
}

class RestartableFakeHost implements WritingHost {
  currentPresentation: PresentationSnapshot | undefined;
  currentActions: SuggestionActions | undefined;
  observationCount = 0;
  private currentQueue: AsyncQueue<HostObservation> | undefined;

  readonly apply = vi.fn(
    async (_request: HostApplyRequest): Promise<HostApplyOutcome> => ({
      status: "indeterminate",
    }),
  );

  constructor(private readonly currentSnapshot: DocumentSnapshot) {}

  async *observe(signal: AbortSignal): AsyncIterable<HostObservation> {
    this.observationCount += 1;
    const queue = new AsyncQueue<HostObservation>();
    this.currentQueue = queue;
    const abort = (): void => queue.close();
    signal.addEventListener("abort", abort, { once: true });
    queue.push({ type: "snapshot", snapshot: this.currentSnapshot });
    try {
      yield* queue;
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.currentQueue === queue) {
        this.currentQueue = undefined;
      }
    }
  }

  validateRevision(revision: string): Promise<HostRevisionValidation> {
    return Promise.resolve(
      revision === this.currentSnapshot.revision
        ? { status: "current" }
        : { status: "stale", snapshot: this.currentSnapshot },
    );
  }

  present(snapshot: PresentationSnapshot, actions: SuggestionActions): void {
    this.currentPresentation = snapshot;
    this.currentActions = actions;
  }
}

class ReconnectingEngine {
  readonly sessions: FakeSession[] = [];

  constructor(
    private readonly epochs: readonly string[] = ["epoch-1"],
    private readonly resumed: readonly boolean[] = [],
  ) {}

  connect(): Promise<RefineTransportSession> {
    const index = this.sessions.length;
    const session = new FakeSession(
      this.epochs[index] ?? this.epochs.at(-1) ?? "epoch-1",
      this.resumed[index] ?? index > 0,
    );
    this.sessions.push(session);
    return Promise.resolve(session.transport);
  }
}

class FakeSession {
  readonly commands: { command: ClientCommand; id: string }[] = [];
  readonly events = new AsyncQueue<ServerEventEnvelope>();
  private sequence = 0;
  readonly transport: RefineTransportSession;

  constructor(serverEpoch: string, runResumed: boolean) {
    this.transport = {
      serverEpoch,
      runResumed,
      send: async (command): Promise<CommandReceipt> => {
        this.sequence += 1;
        const id = `command-${this.sequence}`;
        this.commands.push({ command, id });
        return { sequence: this.sequence, id };
      },
      events: () => this.events,
      close: async () => this.events.close(),
    };
  }
}

class FakeEngine {
  readonly commands: { command: ClientCommand; id: string }[] = [];
  readonly eventQueue = new AsyncQueue<ServerEventEnvelope>();
  private commandSequence = 0;
  private eventSequence = 0;

  connect(): Promise<RefineTransportSession> {
    return Promise.resolve({
      serverEpoch: "epoch-1",
      runResumed: false,
      send: async (command): Promise<CommandReceipt> => {
        this.commandSequence += 1;
        const id = `command-${this.commandSequence}`;
        this.commands.push({ command, id });
        return { sequence: this.commandSequence, id };
      },
      events: () => this.eventQueue,
      close: async () => this.eventQueue.close(),
    });
  }

  emit(event: ServerEventEnvelope["event"]): void {
    this.eventSequence += 1;
    this.eventQueue.push({
      type: "event",
      sequence: this.eventSequence,
      epoch: "epoch-1",
      event,
    });
  }
}

function snapshot(revision: string, text: string): DocumentSnapshot {
  return {
    revision,
    sources: [{ sourceId: "document", text, sourceSyntax: "mixed" }],
  };
}

function suggestionPresentation(
  checkId: string,
  suggestionId: string,
): Extract<
  ServerEventEnvelope["event"],
  { readonly type: "presentationContentReplaced" }
> {
  return {
    type: "presentationContentReplaced",
    checkId,
    content: {
      documentRevision: "doc:0",
      status: "complete",
      coverage: "full",
      appearance: DEFAULT_PRESENTATION_APPEARANCE,
      suggestions: [
        {
          id: suggestionId,
          sourceId: "document",
          kind: "grammar",
          highlightRanges: [{ location: 7, length: 2 }],
          diff: [],
          availableActions: ["apply"],
        },
      ],
    },
  };
}
