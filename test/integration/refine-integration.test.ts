import { describe, expect, it, vi } from "vitest";

import { createRefineIntegration } from "../../src/integration/refine-integration";
import {
  DEFAULT_PRESENTATION_APPEARANCE,
  DEFAULT_PRESENTATION_INTERACTION,
} from "../../src/integration/types";
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
import type {
  PresentationAppearance,
  PresentationInteraction,
} from "../../src/integration/types";
import { AsyncQueue } from "../../src/shared/async-queue";
import { graphemeBoundaries } from "../../src/shared/grapheme-boundaries";
import type {
  CommandReceipt,
  RefineTransportSession,
} from "../../src/transport/refine-transport";
import type {
  ClientCommand,
  ServerEventEnvelope,
} from "../../src/transport/wire";

vi.mock("../../src/shared/grapheme-boundaries", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../src/shared/grapheme-boundaries")
  >();
  return {
    ...original,
    graphemeBoundaries: vi.fn(original.graphemeBoundaries),
  };
});

const TEST_ATTRIBUTION = {
  languageDisplayName: "English (American)",
  textDirection: "ltr" as const,
  checkModelDisplayName: "On-Device (Gemma)",
};

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
        interaction: DEFAULT_PRESENTATION_INTERACTION,
        suggestions: [
          {
            id: "suggestion-1",
            sourceId: "document",
            kind: "grammar",
            attribution: TEST_ATTRIBUTION,
            activationRange: { location: 8, length: 2 },
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
        interaction: DEFAULT_PRESENTATION_INTERACTION,
        suggestions: [
          {
            id: "old",
            sourceId: "document",
            kind: "grammar",
            attribution: TEST_ATTRIBUTION,
            activationRange: { location: 7, length: 2 },
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
        interaction: DEFAULT_PRESENTATION_INTERACTION,
        suggestions: [],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.currentPresentation?.documentRevision).toBe("doc:1");

    controller.abort();
    host.observations.close();
    await run;
  });

  it("retains the latest engine presentation settings across locally synthesized presentations", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));
    expect(host.currentPresentation?.appearance).toEqual(DEFAULT_PRESENTATION_APPEARANCE);
    expect(host.currentPresentation?.interaction).toEqual(DEFAULT_PRESENTATION_INTERACTION);

    engine.emit({
      type: "presentationContentReplaced",
      checkId: "check-appearance",
      content: {
        documentRevision: "doc:0",
        status: "complete",
        coverage: "full",
        appearance: alternateAppearance,
        interaction: alternateInteraction,
        suggestions: [],
      },
    });
    await vi.waitFor(() => {
      expect(host.currentPresentation?.appearance).toEqual(alternateAppearance);
      expect(host.currentPresentation?.interaction).toEqual(alternateInteraction);
    });

    host.observations.push({
      type: "snapshot",
      snapshot: snapshot("doc:1", "create a link"),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation).toMatchObject({
        documentRevision: "doc:1",
        state: { type: "pending" },
        appearance: alternateAppearance,
        interaction: alternateInteraction,
      }),
    );

    controller.abort();
    host.observations.close();
    await run;
    expect(host.currentPresentation).toMatchObject({
      state: { type: "closed" },
      appearance: alternateAppearance,
      interaction: alternateInteraction,
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

  it("advances check lineage only when a different same-revision check is accepted", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link now"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));
    expect(host.currentPresentation?.checkGeneration).toBe(0);
    const initialOpen = engine.commands[0];
    if (!initialOpen) {
      throw new Error("expected openDocument command");
    }
    const localPendingRevision = host.currentPresentation?.presentationRevision ?? 0;

    engine.emit(pendingLifecyclePresentation("pending-before-check"), initialOpen.id);
    await vi.waitFor(() => {
      expect(host.currentPresentation?.state.type).toBe("pending");
      expect(host.currentPresentation?.presentationRevision).toBeGreaterThan(
        localPendingRevision,
      );
    });
    expect(host.currentPresentation?.checkGeneration).toBe(0);

    engine.emit(progressivePresentation("check-1", 1), initialOpen.id);
    await vi.waitFor(() =>
      expect(host.currentPresentation?.suggestions.map(({ id }) => id)).toEqual([
        "sentence-1",
      ]),
    );
    const firstCheckGeneration = host.currentPresentation?.checkGeneration;
    if (firstCheckGeneration === undefined) {
      throw new Error("expected an accepted check generation");
    }
    expect(firstCheckGeneration).toBeGreaterThan(0);

    engine.emit(progressivePresentation("check-1", 2), initialOpen.id);
    await vi.waitFor(() =>
      expect(host.currentPresentation?.suggestions.map(({ id }) => id)).toEqual([
        "sentence-1",
        "sentence-2",
      ]),
    );
    expect(host.currentPresentation?.checkGeneration).toBe(firstCheckGeneration);

    const settingsReplacement = progressivePresentation("check-1", 2);
    engine.emit({
      ...settingsReplacement,
      content: {
        documentRevision: settingsReplacement.content.documentRevision,
        status: "complete",
        coverage: "full",
        appearance: settingsReplacement.content.appearance,
        interaction: alternateInteraction,
        suggestions: settingsReplacement.content.suggestions,
      },
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.interaction).toEqual(alternateInteraction),
    );
    expect(host.currentPresentation?.checkGeneration).toBe(firstCheckGeneration);

    const apply = host.currentActions?.apply("sentence-1");
    if (!apply) {
      throw new Error("expected Apply action");
    }
    await vi.waitFor(() =>
      expect(host.currentPresentation?.suggestions[0]?.availableActions).toEqual([]),
    );
    expect(host.currentPresentation?.checkGeneration).toBe(firstCheckGeneration);
    const perform = engine.commands.find(
      ({ command }) => command.type === "performAction",
    )?.command;
    if (!perform || perform.type !== "performAction") {
      throw new Error("expected performAction command");
    }
    engine.emit({
      type: "actionRejected",
      actionId: perform.actionId,
      reason: "readOnly",
    });
    await expect(apply).resolves.toEqual({
      status: "unavailable",
      reason: "readOnly",
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.suggestions[0]?.availableActions).toEqual([
        "apply",
      ]),
    );
    expect(host.currentPresentation?.checkGeneration).toBe(firstCheckGeneration);

    host.observations.push({ type: "checkRequested", revision: "doc:0" });
    await vi.waitFor(() =>
      expect(engine.commands.at(-1)?.command.type).toBe("requestCheck"),
    );
    engine.emit(progressivePresentation("check-2", 1));
    await vi.waitFor(() =>
      expect(host.currentPresentation?.suggestions.map(({ id }) => id)).toEqual([
        "sentence-1",
      ]),
    );
    expect(host.currentPresentation?.checkGeneration).toBeGreaterThan(
      firstCheckGeneration,
    );

    controller.abort();
    host.observations.close();
    await run;
  });

  it("maps repeated cumulative checking progress into full host replacements", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));
    const firstSuggestion = suggestionPresentation(
      "progress-check",
      "sentence-1",
    ).content.suggestions[0]!;
    const secondSuggestion = {
      ...firstSuggestion,
      id: "sentence-2",
      highlightRanges: [{ location: 10, length: 4 }],
    };

    engine.emit(checkingLifecyclePresentation("progress-check"));
    await vi.waitFor(() => {
      expect(host.currentPresentation?.state).toEqual({ type: "checking" });
      expect(host.currentPresentation?.suggestions).toEqual([]);
    });

    engine.emit({
      type: "presentationContentReplaced",
      checkId: "progress-check",
      content: {
        documentRevision: "doc:0",
        status: "checking",
        progress: { completedUnitCount: 1, totalUnitCount: 3 },
        appearance: DEFAULT_PRESENTATION_APPEARANCE,
        interaction: DEFAULT_PRESENTATION_INTERACTION,
        suggestions: [firstSuggestion],
      },
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation).toMatchObject({
        state: {
          type: "checking",
          progress: { completedUnitCount: 1, totalUnitCount: 3 },
        },
        suggestions: [{ id: "sentence-1" }],
      }),
    );
    const firstPresentation = host.currentPresentation!;
    const firstActions = host.currentActions!;

    engine.emit({
      type: "presentationContentReplaced",
      checkId: "progress-check",
      content: {
        documentRevision: "doc:0",
        status: "checking",
        progress: { completedUnitCount: 2, totalUnitCount: 3 },
        appearance: DEFAULT_PRESENTATION_APPEARANCE,
        interaction: DEFAULT_PRESENTATION_INTERACTION,
        suggestions: [firstSuggestion, secondSuggestion],
      },
    });
    await vi.waitFor(() => {
      expect(host.currentPresentation).toMatchObject({
        state: {
          type: "checking",
          progress: { completedUnitCount: 2, totalUnitCount: 3 },
        },
      });
      expect(host.currentPresentation?.suggestions.map(({ id }) => id)).toEqual([
        "sentence-1",
        "sentence-2",
      ]);
    });
    expect(host.currentPresentation!.presentationRevision).toBeGreaterThan(
      firstPresentation.presentationRevision,
    );
    await expect(firstActions.apply("sentence-1")).resolves.toEqual({
      status: "stale",
    });

    const secondPresentation = host.currentPresentation!;
    const secondActions = host.currentActions!;
    engine.emit({
      type: "presentationContentReplaced",
      checkId: "progress-check",
      content: {
        documentRevision: "doc:0",
        status: "checking",
        progress: { completedUnitCount: 3, totalUnitCount: 3 },
        appearance: DEFAULT_PRESENTATION_APPEARANCE,
        interaction: DEFAULT_PRESENTATION_INTERACTION,
        suggestions: [firstSuggestion, secondSuggestion],
      },
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation).toMatchObject({
        state: {
          type: "checking",
          progress: { completedUnitCount: 3, totalUnitCount: 3 },
        },
      }),
    );
    expect(host.currentPresentation!.presentationRevision).toBeGreaterThan(
      secondPresentation.presentationRevision,
    );
    await expect(secondActions.apply("sentence-1")).resolves.toEqual({
      status: "stale",
    });

    engine.emit({
      type: "presentationContentReplaced",
      checkId: "progress-check",
      content: {
        documentRevision: "doc:0",
        status: "complete",
        coverage: "full",
        appearance: DEFAULT_PRESENTATION_APPEARANCE,
        interaction: DEFAULT_PRESENTATION_INTERACTION,
        suggestions: [firstSuggestion, secondSuggestion],
      },
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation).toMatchObject({
        state: { type: "complete", coverage: "full" },
        suggestions: [{ id: "sentence-1" }, { id: "sentence-2" }],
      }),
    );

    controller.abort();
    host.observations.close();
    await run;
  });

  it("ignores a stale terminal presentation after a newer same-revision check starts", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link now"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));

    const older = progressivePresentation("check-a", 1);
    engine.emit({
      ...older,
      content: {
        ...older.content,
        suggestions: older.content.suggestions.map((suggestion) => ({
          ...suggestion,
          id: "older-suggestion",
        })),
      },
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.suggestions.map(({ id }) => id)).toEqual([
        "older-suggestion",
      ]),
    );

    const newer = progressivePresentation("check-b", 1);
    engine.emit({
      ...newer,
      content: {
        ...newer.content,
        suggestions: newer.content.suggestions.map((suggestion) => ({
          ...suggestion,
          id: "newer-suggestion",
        })),
      },
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.suggestions.map(({ id }) => id)).toEqual([
        "newer-suggestion",
      ]),
    );
    const firstNewerRevision = host.currentPresentation!.presentationRevision;

    engine.emit(suggestionPresentation("check-a", "stale-suggestion"));
    engine.emit(suggestionPresentation("check-b", "newer-suggestion"));

    await vi.waitFor(() =>
      expect(host.currentPresentation).toMatchObject({
        state: { type: "complete", coverage: "full" },
        suggestions: [{ id: "newer-suggestion" }],
      }),
    );
    expect(
      host.presentations
        .filter(
          ({ presentationRevision }) =>
            presentationRevision > firstNewerRevision,
        )
        .map(({ suggestions }) => suggestions.map(({ id }) => id)),
    ).toEqual([["newer-suggestion"]]);

    controller.abort();
    host.observations.close();
    await run;
  });

  it("reuses grapheme boundaries across progressive replacements and recomputes them for the next revision", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));
    const boundaries = vi.mocked(graphemeBoundaries);
    boundaries.mockClear();

    engine.emit(progressivePresentation("boundary-cache", 1));
    await vi.waitFor(() =>
      expect(host.currentPresentation?.suggestions.map(({ id }) => id)).toEqual([
        "sentence-1",
      ]),
    );
    expect(boundaries).toHaveBeenCalledTimes(1);

    engine.emit(progressivePresentation("boundary-cache", 2));
    await vi.waitFor(() =>
      expect(host.currentPresentation?.suggestions.map(({ id }) => id)).toEqual([
        "sentence-1",
        "sentence-2",
      ]),
    );
    expect(boundaries).toHaveBeenCalledTimes(1);

    host.observations.push({
      type: "snapshot",
      snapshot: snapshot("doc:1", "create an link"),
    });
    await vi.waitFor(() =>
      expect(engine.commands.at(-1)?.command).toEqual({
        type: "replaceDocument",
        snapshot: snapshot("doc:1", "create an link"),
      }),
    );
    const nextRevision = suggestionPresentation("boundary-cache-next", "sentence-1");
    engine.emit({
      ...nextRevision,
      content: { ...nextRevision.content, documentRevision: "doc:1" },
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation).toMatchObject({
        documentRevision: "doc:1",
        suggestions: [{ id: "sentence-1" }],
      }),
    );
    expect(boundaries).toHaveBeenCalledTimes(2);

    controller.abort();
    host.observations.close();
    await run;
  });

  it.each([
    {
      name: "starts before the source",
      activationRange: { location: -1, length: 0 },
    },
    {
      name: "extends beyond the source",
      activationRange: { location: 0, length: 5 },
    },
    {
      name: "splits a grapheme",
      activationRange: { location: 2, length: 0 },
    },
    {
      name: "uses a fractional boundary",
      activationRange: { location: 1.5, length: 0 },
    },
  ])("fails closed when an activation range $name", async ({ activationRange }) => {
    const host = new FakeHost(snapshot("doc:0", "A😀B"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const run = integration.run({ host, signal: new AbortController().signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));
    const presentation = suggestionPresentation("invalid-activation", "suggestion-1");

    engine.emit({
      ...presentation,
      content: {
        ...presentation.content,
        suggestions: presentation.content.suggestions.map((suggestion) => ({
          ...suggestion,
          activationRange,
          highlightRanges: [{ location: 0, length: 1 }],
        })),
      },
    });

    await expect(run).rejects.toThrow("invalid activation range");
  });

  it.each([
    {
      name: "changes the total count",
      events: [
        checkingLifecyclePresentation("lifecycle-total", {
          completedUnitCount: 1,
          totalUnitCount: 3,
        }),
        checkingLifecyclePresentation("lifecycle-total", {
          completedUnitCount: 2,
          totalUnitCount: 4,
        }),
      ],
      message: "changed the total progress count",
    },
    {
      name: "decreases the completed count",
      events: [
        checkingLifecyclePresentation("lifecycle-decrease", {
          completedUnitCount: 2,
          totalUnitCount: 3,
        }),
        checkingLifecyclePresentation("lifecycle-decrease", {
          completedUnitCount: 1,
          totalUnitCount: 3,
        }),
      ],
      message: "decreased completed progress",
    },
    {
      name: "drops determinate progress",
      events: [
        checkingLifecyclePresentation("lifecycle-drop", {
          completedUnitCount: 1,
          totalUnitCount: 3,
        }),
        checkingLifecyclePresentation("lifecycle-drop"),
      ],
      message: "removed determinate progress",
    },
    {
      name: "returns to pending while active",
      events: [
        checkingLifecyclePresentation("lifecycle-active-pending"),
        pendingLifecyclePresentation("lifecycle-active-pending"),
      ],
      message: "returned an active check to pending",
    },
    {
      name: "returns to checking after completion",
      events: [
        completeLifecyclePresentation("lifecycle-terminal"),
        checkingLifecyclePresentation("lifecycle-terminal", {
          completedUnitCount: 1,
          totalUnitCount: 3,
        }),
      ],
      message: "regressed a check after its terminal presentation",
    },
    {
      name: "returns to pending after completion",
      events: [
        completeLifecyclePresentation("lifecycle-pending"),
        pendingLifecyclePresentation("lifecycle-pending"),
      ],
      message: "regressed a check after its terminal presentation",
    },
  ])("fails closed when same-check progress $name", async ({ events, message }) => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const run = integration.run({ host, signal: new AbortController().signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));

    for (const event of events) {
      engine.emit(event);
    }

    await expect(run).rejects.toThrow(message);
  });

  it.each([
    { completedUnitCount: -1, totalUnitCount: 3 },
    { completedUnitCount: 1.5, totalUnitCount: 3 },
    { completedUnitCount: 4, totalUnitCount: 3 },
  ])("fails closed on invalid in-memory progress %o", async (progress) => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const run = integration.run({ host, signal: new AbortController().signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));

    engine.emit(checkingLifecyclePresentation("invalid-progress", progress));

    await expect(run).rejects.toThrow("malformed checking progress");
  });

  it("allows an unavailable check to terminate before determinate progress finishes", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));

    engine.emit(checkingLifecyclePresentation("early-unavailable", {
      completedUnitCount: 1,
      totalUnitCount: 3,
    }));
    engine.emit(unavailableLifecyclePresentation("early-unavailable"));
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "unavailable",
        reason: "checkFailed",
      }),
    );

    controller.abort();
    host.observations.close();
    await run;
  });

  it("continues the same check after a recoverable presentation failure", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));

    engine.emit(checkingLifecyclePresentation("recoverable-check", {
      completedUnitCount: 1,
      totalUnitCount: 3,
    }));
    engine.emit(unavailableLifecyclePresentation("recoverable-check"));
    engine.emit(checkingLifecyclePresentation("recoverable-check", {
      completedUnitCount: 2,
      totalUnitCount: 3,
    }));
    engine.emit(completeLifecyclePresentation("recoverable-check"));

    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "complete",
        coverage: "full",
      }),
    );

    controller.abort();
    host.observations.close();
    await run;
  });

  it("can report a presentation failure after a completed check and recover", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));

    engine.emit(completeLifecyclePresentation("rematerialized-check"));
    engine.emit(unavailableLifecyclePresentation("rematerialized-check"));
    engine.emit(completeLifecyclePresentation("rematerialized-check"));

    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "complete",
        coverage: "full",
      }),
    );

    controller.abort();
    host.observations.close();
    await run;
  });

  it("accepts complete when the final determinate checking update was coalesced", async () => {
    const host = new BlockingCheckingHost(
      snapshot("doc:0", "create an link now"),
    );
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));

    engine.emit(checkingLifecyclePresentation("coalesced-terminal", {
      completedUnitCount: 1,
      totalUnitCount: 3,
    }));
    await vi.waitFor(() => expect(host.hasBlockedChecking).toBe(true));
    engine.emit(checkingLifecyclePresentation("coalesced-terminal", {
      completedUnitCount: 2,
      totalUnitCount: 3,
    }));
    engine.emit(completeLifecyclePresentation("coalesced-terminal"));
    await vi.waitFor(() => expect(engine.eventsRead).toBe(3));

    host.releaseChecking();
    await vi.waitFor(() => {
      expect(host.presentations.map(({ state }) => state.type)).toContain("complete");
      expect(
        host.presentations.flatMap(({ state }) =>
          state.type === "checking" && state.progress !== undefined
            ? [state.progress.completedUnitCount]
            : [],
        ),
      ).toEqual([1]);
    });

    controller.abort();
    host.observations.close();
    await run;
  });

  it("does not coalesce a completed check into a later presentation failure", async () => {
    const host = new BlockingCheckingHost(
      snapshot("doc:0", "create an link now"),
    );
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));

    engine.emit(checkingLifecyclePresentation("terminal-barrier", {
      completedUnitCount: 1,
      totalUnitCount: 1,
    }));
    await vi.waitFor(() => expect(host.hasBlockedChecking).toBe(true));
    engine.emit(completeLifecyclePresentation("terminal-barrier"));
    engine.emit(unavailableLifecyclePresentation("terminal-barrier"));
    await vi.waitFor(() => expect(engine.eventsRead).toBe(3));

    host.releaseChecking();
    await vi.waitFor(() => {
      const states = host.presentations.map(({ state }) => state.type);
      expect(states.slice(-3)).toEqual(["checking", "complete", "unavailable"]);
    });

    controller.abort();
    host.observations.close();
    await run;
  });

  it("reads ahead and keeps only the latest queued same-check presentation", async () => {
    const host = new BlockingCheckingHost(
      snapshot("doc:0", "create an link now"),
    );
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));

    engine.emit(progressivePresentation("read-ahead", 1));
    await vi.waitFor(() => expect(host.hasBlockedChecking).toBe(true));
    engine.emit(progressivePresentation("read-ahead", 2));
    engine.emit(progressivePresentation("read-ahead", 3));

    host.releaseChecking();
    await vi.waitFor(() => {
      const checking = host.presentations.filter(
        ({ state }) => state.type === "checking",
      );
      expect(checking.map(({ suggestions }) =>
        suggestions.map(({ id }) => id)
      )).toEqual([
        ["sentence-1"],
        ["sentence-1", "sentence-2", "sentence-3"],
      ]);
    });

    controller.abort();
    host.observations.close();
    await run;
  });

  it.each([
    [
      "action",
      { type: "actionCompleted", actionId: "barrier-action" } as const,
    ],
    [
      "fault",
      { type: "fault", code: "engineUnavailable", fatal: false } as const,
    ],
    [
      "document",
      { type: "documentAccepted", revision: "doc:0" } as const,
    ],
  ])("does not coalesce same-check presentations across a %s barrier", async (
    kind,
    barrier,
  ) => {
    const host = new BlockingCheckingHost(
      snapshot("doc:0", "create an link now"),
    );
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));

    engine.emit(progressivePresentation(`barrier-${kind}`, 1));
    await vi.waitFor(() => expect(host.hasBlockedChecking).toBe(true));
    engine.emit(progressivePresentation(`barrier-${kind}`, 2));
    engine.emit(barrier);
    engine.emit(progressivePresentation(`barrier-${kind}`, 3));

    host.releaseChecking();
    await vi.waitFor(() => {
      const checking = host.presentations.filter(
        ({ state }) => state.type === "checking",
      );
      expect(checking.map(({ suggestions }) => suggestions.length)).toEqual([
        1,
        2,
        3,
      ]);
      if (kind === "fault") {
        expect(host.presentations.some(
          ({ state }) => state.type === "unavailable",
        )).toBe(true);
      }
    });

    controller.abort();
    host.observations.close();
    await run;
  });

  it("coalesces more than the buffer limit while preserving nonpresentation barriers", async () => {
    const host = new BlockingCheckingHost(
      snapshot("doc:0", "create an link now"),
    );
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));

    engine.emit(
      checkingLifecyclePresentation("large-progress-burst", {
        completedUnitCount: 0,
        totalUnitCount: 256,
      }),
    );
    await vi.waitFor(() => expect(host.hasBlockedChecking).toBe(true));
    for (
      let completedUnitCount = 1;
      completedUnitCount <= 256;
      completedUnitCount += 1
    ) {
      engine.emit(
        checkingLifecyclePresentation("large-progress-burst", {
          completedUnitCount,
          totalUnitCount: 256,
        }),
      );
      if (completedUnitCount === 64) {
        engine.emit({ type: "documentAccepted", revision: "doc:0" });
      } else if (completedUnitCount === 128) {
        engine.emit({ type: "actionCompleted", actionId: "burst-action" });
      } else if (completedUnitCount === 192) {
        engine.emit({ type: "fault", code: "diagnostic", fatal: false });
      }
    }
    await vi.waitFor(() => expect(engine.eventsRead).toBe(260));

    host.releaseChecking();
    await vi.waitFor(() => {
      const progress = host.presentations.flatMap(({ state }) =>
        state.type === "checking" && state.progress !== undefined
          ? [state.progress.completedUnitCount]
          : [],
      );
      expect(progress).toEqual([0, 64, 128, 192, 256]);
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

  it("keeps an automatic check live when an older resumed server replays it under a fresh check ID", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new ReconnectingEngine();
    const integration = createRefineIntegration({
      enginePort: engine,
      reconnectDelayMs: 0,
    });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.sessions[0]?.commands).toHaveLength(1));

    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      event: checkingLifecyclePresentation("automatic-check", {
        completedUnitCount: 1,
        totalUnitCount: 2,
      }),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "checking",
        progress: { completedUnitCount: 1, totalUnitCount: 2 },
      }),
    );
    engine.sessions[0]?.events.close();

    await vi.waitFor(() => {
      expect(engine.sessions).toHaveLength(2);
      expect(engine.sessions[1]?.commands.map(({ command }) => command.type)).toEqual([
        "openDocument",
      ]);
    });
    const reconnectOpen = engine.sessions[1]?.commands[0];
    if (!reconnectOpen) {
      throw new Error("expected reconnect openDocument command");
    }
    engine.sessions[1]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      causeCommandId: reconnectOpen.id,
      event: checkingLifecyclePresentation("legacy-replay-check", {
        completedUnitCount: 1,
        totalUnitCount: 2,
      }),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "checking",
        progress: { completedUnitCount: 1, totalUnitCount: 2 },
      }),
    );
    engine.sessions[1]?.events.push({
      type: "event",
      sequence: 2,
      epoch: "epoch-1",
      event: checkingLifecyclePresentation("legacy-replay-check", {
        completedUnitCount: 2,
        totalUnitCount: 2,
      }),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "checking",
        progress: { completedUnitCount: 2, totalUnitCount: 2 },
      }),
    );
    engine.sessions[1]?.events.push({
      type: "event",
      sequence: 3,
      epoch: "epoch-1",
      event: completeLifecyclePresentation("legacy-replay-check"),
    });
    await vi.waitFor(() => {
      expect(host.currentPresentation?.state).toEqual({
        type: "complete",
        coverage: "full",
      });
      expect(engine.sessions[1]?.commands.map(({ command }) => command.type)).toEqual([
        "openDocument",
      ]);
    });
    engine.sessions[1]?.events.close();

    await vi.waitFor(() => {
      expect(engine.sessions).toHaveLength(3);
      expect(engine.sessions[2]?.commands.map(({ command }) => command.type)).toEqual([
        "openDocument",
      ]);
    });
    const secondReconnectOpen = engine.sessions[2]?.commands[0];
    if (!secondReconnectOpen) {
      throw new Error("expected second reconnect openDocument command");
    }
    engine.sessions[2]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      causeCommandId: secondReconnectOpen.id,
      event: completeLifecyclePresentation("second-legacy-replay-check"),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "complete",
        coverage: "full",
      }),
    );
    engine.sessions[2]?.events.push({
      type: "event",
      sequence: 2,
      epoch: "epoch-1",
      event: suggestionPresentation("automatic-check", "automatic-full-result"),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.suggestions.map(({ id }) => id)).toEqual([
        "automatic-full-result",
      ]),
    );

    controller.abort();
    host.observations.close();
    engine.sessions[2]?.events.close();
    await run;
  });

  it("keeps an active check live when older settings rematerialization looks complete", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new ReconnectingEngine();
    const integration = createRefineIntegration({
      enginePort: engine,
      reconnectDelayMs: 0,
    });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.sessions[0]?.commands).toHaveLength(1));
    const initialOpen = engine.sessions[0]?.commands[0];
    if (!initialOpen) {
      throw new Error("expected initial openDocument command");
    }

    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      causeCommandId: initialOpen.id,
      event: checkingLifecyclePresentation("settings-check", {
        completedUnitCount: 1,
        totalUnitCount: 2,
      }),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state.type).toBe("checking"),
    );
    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 2,
      epoch: "epoch-1",
      event: completeLifecyclePresentation("settings-check"),
    });
    await vi.waitFor(() => {
      expect(host.currentPresentation?.state).toEqual({
        type: "complete",
        coverage: "full",
      });
      expect(engine.sessions[0]?.commands.map(({ command }) => command.type)).toEqual([
        "openDocument",
      ]);
    });
    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 3,
      epoch: "epoch-1",
      event: completeLifecyclePresentation("settings-check"),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "complete",
        coverage: "full",
      }),
    );
    engine.sessions[0]?.events.close();

    await vi.waitFor(() => {
      expect(engine.sessions).toHaveLength(2);
      expect(engine.sessions[1]?.commands.map(({ command }) => command.type)).toEqual([
        "openDocument",
      ]);
    });
    const reconnectOpen = engine.sessions[1]?.commands[0];
    if (!reconnectOpen) {
      throw new Error("expected reconnect openDocument command");
    }
    engine.sessions[1]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      causeCommandId: reconnectOpen.id,
      event: completeLifecyclePresentation("legacy-settings-replay"),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "complete",
        coverage: "full",
      }),
    );
    engine.sessions[1]?.events.push({
      type: "event",
      sequence: 2,
      epoch: "epoch-1",
      causeCommandId: initialOpen.id,
      event: suggestionPresentation("settings-check", "settings-full-result"),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation).toMatchObject({
        state: { type: "complete", coverage: "full" },
        suggestions: [{ id: "settings-full-result" }],
      }),
    );

    controller.abort();
    host.observations.close();
    engine.sessions[1]?.events.close();
    await run;
  });

  it("keeps a manual check bound when settings rematerializes it as complete", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new ReconnectingEngine();
    const integration = createRefineIntegration({
      enginePort: engine,
      reconnectDelayMs: 0,
    });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.sessions[0]?.commands).toHaveLength(1));

    host.observations.push({ type: "checkRequested", revision: "doc:0" });
    await vi.waitFor(() =>
      expect(engine.sessions[0]?.commands.at(-1)?.command.type).toBe(
        "requestCheck",
      ),
    );
    const request = engine.sessions[0]?.commands.at(-1);
    if (!request) {
      throw new Error("expected requestCheck command");
    }
    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      causeCommandId: request.id,
      event: checkingLifecyclePresentation("manual-settings-check", {
        completedUnitCount: 1,
        totalUnitCount: 2,
      }),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state.type).toBe("checking"),
    );

    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 2,
      epoch: "epoch-1",
      event: completeLifecyclePresentation("manual-settings-check"),
    });
    await vi.waitFor(() => {
      expect(host.currentPresentation?.state).toEqual({
        type: "complete",
        coverage: "full",
      });
      expect(engine.sessions[0]?.commands).toHaveLength(2);
    });

    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 3,
      epoch: "epoch-1",
      causeCommandId: request.id,
      event: checkingLifecyclePresentation("manual-settings-check", {
        completedUnitCount: 2,
        totalUnitCount: 2,
      }),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "checking",
        progress: { completedUnitCount: 2, totalUnitCount: 2 },
      }),
    );
    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 4,
      epoch: "epoch-1",
      causeCommandId: request.id,
      event: completeLifecyclePresentation("manual-settings-check"),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "complete",
        coverage: "full",
      }),
    );
    engine.sessions[0]?.events.close();

    await vi.waitFor(() => {
      expect(engine.sessions).toHaveLength(2);
      expect(engine.sessions[1]?.commands.map(({ command }) => command.type)).toEqual([
        "openDocument",
      ]);
    });

    controller.abort();
    host.observations.close();
    engine.sessions[1]?.events.close();
    await run;
  });

  it("keeps a detached terminal replay without starting another full check", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new ReconnectingEngine();
    const integration = createRefineIntegration({
      enginePort: engine,
      reconnectDelayMs: 0,
    });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.sessions[0]?.commands).toHaveLength(1));

    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      event: checkingLifecyclePresentation("detached-check", {
        completedUnitCount: 1,
        totalUnitCount: 2,
      }),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state.type).toBe("checking"),
    );
    engine.sessions[0]?.events.close();

    await vi.waitFor(() => {
      expect(engine.sessions).toHaveLength(2);
      expect(engine.sessions[1]?.commands.map(({ command }) => command.type)).toEqual([
        "openDocument",
      ]);
    });
    const reconnectOpen = engine.sessions[1]?.commands[0];
    if (!reconnectOpen) {
      throw new Error("expected reconnect openDocument command");
    }
    engine.sessions[1]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      causeCommandId: reconnectOpen.id,
      event: completeLifecyclePresentation("detached-complete-replay"),
    });

    await vi.waitFor(() => {
      expect(host.currentPresentation?.state).toEqual({
        type: "complete",
        coverage: "full",
      });
      expect(engine.sessions[1]?.commands.map(({ command }) => command.type)).toEqual([
        "openDocument",
      ]);
    });

    controller.abort();
    host.observations.close();
    engine.sessions[1]?.events.close();
    await run;
  });

  it("accepts a fresh pending check from reconnect open after the retained check was superseded while detached", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new ReconnectingEngine();
    const integration = createRefineIntegration({
      enginePort: engine,
      reconnectDelayMs: 0,
    });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.sessions[0]?.commands).toHaveLength(1));

    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      event: checkingLifecyclePresentation("retained-check", {
        completedUnitCount: 1,
        totalUnitCount: 2,
      }),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state.type).toBe("checking"),
    );
    engine.sessions[0]?.events.close();

    await vi.waitFor(() => {
      expect(engine.sessions).toHaveLength(2);
      expect(engine.sessions[1]?.commands.map(({ command }) => command.type)).toEqual([
        "openDocument",
      ]);
    });
    const reconnectPendingRevision =
      host.currentPresentation?.presentationRevision ?? 0;
    const reconnectOpen = engine.sessions[1]?.commands[0];
    if (!reconnectOpen) {
      throw new Error("expected reconnect openDocument command");
    }
    engine.sessions[1]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      causeCommandId: reconnectOpen.id,
      event: pendingLifecyclePresentation("replacement-check"),
    });

    await vi.waitFor(() => {
      expect(host.currentPresentation?.state).toEqual({ type: "pending" });
      expect(host.currentPresentation?.presentationRevision).toBeGreaterThan(
        reconnectPendingRevision,
      );
    });
    engine.sessions[1]?.events.push({
      type: "event",
      sequence: 2,
      epoch: "epoch-1",
      event: checkingLifecyclePresentation("replacement-check", {
        completedUnitCount: 0,
        totalUnitCount: 1,
      }),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "checking",
        progress: { completedUnitCount: 0, totalUnitCount: 1 },
      }),
    );

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

  it("does not replay a manual check after its bound check fails without a command cause", async () => {
    const host = new FakeHost(snapshot("doc:0", "first"));
    const engine = new ReconnectingEngine();
    const integration = createRefineIntegration({
      enginePort: engine,
      reconnectDelayMs: 0,
    });
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
    const request = engine.sessions[0]?.commands.at(-1);
    if (!request) {
      throw new Error("expected requestCheck command");
    }

    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      causeCommandId: request.id,
      event: checkingLifecyclePresentation("manual-check", {
        completedUnitCount: 1,
        totalUnitCount: 2,
      }),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "checking",
        progress: { completedUnitCount: 1, totalUnitCount: 2 },
      }),
    );

    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 2,
      epoch: "epoch-1",
      event: completeLifecyclePresentation("manual-check"),
    });
    await vi.waitFor(() => {
      expect(host.currentPresentation?.state).toEqual({
        type: "complete",
        coverage: "full",
      });
      expect(engine.sessions[0]?.commands).toHaveLength(2);
    });

    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 3,
      epoch: "epoch-1",
      event: unavailableLifecyclePresentation("manual-check"),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "unavailable",
        reason: "checkFailed",
      }),
    );
    engine.sessions[0]?.events.close();

    await vi.waitFor(() => {
      expect(engine.sessions).toHaveLength(2);
      expect(engine.sessions[1]?.commands.map(({ command }) => command.type)).toEqual([
        "openDocument",
      ]);
    });

    controller.abort();
    host.observations.close();
    engine.sessions[1]?.events.close();
    await run;
  });

  it("accepts a retained check result after unavailable rematerializes across reconnects", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new ReconnectingEngine();
    const integration = createRefineIntegration({
      enginePort: engine,
      reconnectDelayMs: 0,
    });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.sessions[0]?.commands).toHaveLength(1));

    host.observations.push({ type: "checkRequested", revision: "doc:0" });
    await vi.waitFor(() =>
      expect(engine.sessions[0]?.commands.at(-1)?.command.type).toBe(
        "requestCheck",
      ),
    );
    const request = engine.sessions[0]?.commands.at(-1);
    if (!request) {
      throw new Error("expected requestCheck command");
    }
    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      causeCommandId: request.id,
      event: checkingLifecyclePresentation("recoverable-check", {
        completedUnitCount: 1,
        totalUnitCount: 2,
      }),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state.type).toBe("checking"),
    );
    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 2,
      epoch: "epoch-1",
      event: unavailableLifecyclePresentation("recoverable-check"),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "unavailable",
        reason: "checkFailed",
      }),
    );
    engine.sessions[0]?.events.close();

    await vi.waitFor(() => {
      expect(engine.sessions).toHaveLength(2);
      expect(engine.sessions[1]?.commands.map(({ command }) => command.type)).toEqual([
        "openDocument",
      ]);
    });
    const reconnectOpen = engine.sessions[1]?.commands[0];
    if (!reconnectOpen) {
      throw new Error("expected reconnect openDocument command");
    }
    engine.sessions[1]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      causeCommandId: reconnectOpen.id,
      event: unavailableLifecyclePresentation("legacy-unavailable-replay"),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "unavailable",
        reason: "checkFailed",
      }),
    );
    engine.sessions[1]?.events.push({
      type: "event",
      sequence: 2,
      epoch: "epoch-1",
      event: unavailableLifecyclePresentation("legacy-unavailable-replay"),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "unavailable",
        reason: "checkFailed",
      }),
    );
    engine.sessions[1]?.events.push({
      type: "event",
      sequence: 3,
      epoch: "epoch-1",
      event: completeLifecyclePresentation("legacy-unavailable-replay"),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "complete",
        coverage: "full",
      }),
    );
    engine.sessions[1]?.events.close();

    await vi.waitFor(() => {
      expect(engine.sessions).toHaveLength(3);
      expect(engine.sessions[2]?.commands.map(({ command }) => command.type)).toEqual([
        "openDocument",
      ]);
    });
    const secondReconnectOpen = engine.sessions[2]?.commands[0];
    if (!secondReconnectOpen) {
      throw new Error("expected second reconnect openDocument command");
    }
    engine.sessions[2]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      causeCommandId: secondReconnectOpen.id,
      event: unavailableLifecyclePresentation("second-unavailable-replay"),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "unavailable",
        reason: "checkFailed",
      }),
    );
    engine.sessions[2]?.events.push({
      type: "event",
      sequence: 2,
      epoch: "epoch-1",
      causeCommandId: request.id,
      event: suggestionPresentation("recoverable-check", "recovered-result"),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation).toMatchObject({
        state: { type: "complete", coverage: "full" },
        suggestions: [{ id: "recovered-result" }],
      }),
    );

    controller.abort();
    host.observations.close();
    engine.sessions[2]?.events.close();
    await run;
  });

  it.each([
    {
      name: "replays the request when the run resumes",
      epochs: ["epoch-1", "epoch-1"],
      resumed: [false, true],
      reconnectCommands: ["openDocument", "requestCheck"],
    },
    {
      name: "replays the request when Refine starts a fresh run",
      epochs: ["epoch-1", "epoch-2"],
      resumed: [false, false],
      reconnectCommands: ["openDocument", "requestCheck"],
    },
  ])("$name after reconnect", async ({ epochs, resumed, reconnectCommands }) => {
    const host = new FakeHost(snapshot("doc:0", "first"));
    const engine = new ReconnectingEngine(epochs, resumed);
    const integration = createRefineIntegration({
      enginePort: engine,
      reconnectDelayMs: 0,
    });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.sessions[0]?.commands).toHaveLength(1));

    host.observations.push({ type: "checkRequested", revision: "doc:0" });
    await vi.waitFor(() =>
      expect(engine.sessions[0]?.commands.at(-1)?.command.type).toBe(
        "requestCheck",
      ),
    );
    const request = engine.sessions[0]?.commands.at(-1);
    if (!request) {
      throw new Error("expected requestCheck command");
    }
    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 1,
      epoch: epochs[0]!,
      causeCommandId: request.id,
      event: checkingLifecyclePresentation("bound-check", {
        completedUnitCount: 1,
        totalUnitCount: 2,
      }),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state.type).toBe("checking"),
    );
    engine.sessions[0]?.events.close();

    await vi.waitFor(() => {
      expect(engine.sessions).toHaveLength(2);
      expect(engine.sessions[1]?.commands.map(({ command }) => command.type)).toEqual(
        reconnectCommands,
      );
    });
    const replayedRequest = engine.sessions[1]?.commands.find(
      ({ command }) => command.type === "requestCheck",
    );
    if (!replayedRequest) {
      throw new Error("expected replayed requestCheck command");
    }
    engine.sessions[1]?.events.push({
      type: "event",
      sequence: 1,
      epoch: epochs[1]!,
      causeCommandId: replayedRequest.id,
      event: checkingLifecyclePresentation("superseding-check", {
        completedUnitCount: 1,
        totalUnitCount: 3,
      }),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "checking",
        progress: { completedUnitCount: 1, totalUnitCount: 3 },
      }),
    );
    engine.sessions[1]?.events.push({
      type: "event",
      sequence: 2,
      epoch: epochs[1]!,
      event: unavailableLifecyclePresentation("superseding-check"),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "unavailable",
        reason: "checkFailed",
      }),
    );

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
          interaction: DEFAULT_PRESENTATION_INTERACTION,
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

  it.each([
    {
      name: "a new server epoch",
      epochs: ["epoch-1", "epoch-2"],
      resumed: [false, false],
    },
    {
      name: "a non-resumed run in the same epoch",
      epochs: ["epoch-1", "epoch-1"],
      resumed: [false, false],
    },
  ])("starts fresh check progress after reconnecting to $name", async ({
    epochs,
    resumed,
  }) => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new ReconnectingEngine(epochs, resumed);
    const integration = createRefineIntegration({
      enginePort: engine,
      reconnectDelayMs: 0,
    });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.sessions[0]?.commands).toHaveLength(1));

    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 1,
      epoch: epochs[0]!,
      event: checkingLifecyclePresentation("reused-check-id", {
        completedUnitCount: 2,
        totalUnitCount: 3,
      }),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "checking",
        progress: { completedUnitCount: 2, totalUnitCount: 3 },
      }),
    );
    engine.sessions[0]?.events.close();
    await vi.waitFor(() => expect(engine.sessions).toHaveLength(2));

    engine.sessions[1]?.events.push({
      type: "event",
      sequence: 1,
      epoch: epochs[1]!,
      event: checkingLifecyclePresentation("reused-check-id", {
        completedUnitCount: 0,
        totalUnitCount: 2,
      }),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "checking",
        progress: { completedUnitCount: 0, totalUnitCount: 2 },
      }),
    );

    controller.abort();
    host.observations.close();
    engine.sessions[1]?.events.close();
    await run;
  });

  it("starts fresh check lifecycle state after Apply advances the authoritative revision", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));

    engine.emit(suggestionPresentation("reused-after-apply", "suggestion-1"));
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
      transactionId: "revision-lifecycle-transaction",
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
      expect(engine.commands.at(-1)?.command).toMatchObject({
        type: "completeApply",
        transactionId: "revision-lifecycle-transaction",
      });
      expect(host.currentPresentation).toMatchObject({
        documentRevision: "doc:1",
        state: { type: "pending" },
      });
    });

    host.observations.push({ type: "snapshot", snapshot: host.currentSnapshot });
    host.observations.push({ type: "checkRequested", revision: "doc:1" });
    await vi.waitFor(() =>
      expect(engine.commands.at(-1)?.command).toEqual({
        type: "requestCheck",
        revision: "doc:1",
      }),
    );

    const nextRevision = checkingLifecyclePresentation("reused-after-apply");
    engine.emit({
      ...nextRevision,
      content: { ...nextRevision.content, documentRevision: "doc:1" },
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation).toMatchObject({
        documentRevision: "doc:1",
        state: { type: "checking" },
      }),
    );

    engine.emit({ type: "actionCompleted", actionId: perform.actionId });
    await expect(apply).resolves.toEqual({ status: "completed" });
    controller.abort();
    host.observations.close();
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
        interaction: DEFAULT_PRESENTATION_INTERACTION,
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
        interaction: DEFAULT_PRESENTATION_INTERACTION,
        suggestions: [
          {
            id: "dismiss-me",
            sourceId: "document",
            kind: "grammar",
            attribution: TEST_ATTRIBUTION,
            activationRange: { location: 7, length: 2 },
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

  it("keeps an active check live when an older server rematerializes Dismiss under a fresh check ID", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link now"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));

    const active = progressivePresentation("active-check", 1);
    engine.emit({
      ...active,
      content: {
        ...active.content,
        suggestions: active.content.suggestions.map((suggestion) => ({
          ...suggestion,
          id: "dismiss-me",
          availableActions: ["dismiss"],
        })),
      },
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.suggestions).toMatchObject([
        { id: "dismiss-me", availableActions: ["dismiss"] },
      ]),
    );
    const dismissal = host.currentActions?.dismiss("dismiss-me");
    if (!dismissal) {
      throw new Error("expected Dismiss action");
    }
    await vi.waitFor(() =>
      expect(engine.commands.at(-1)?.command.type).toBe("performAction"),
    );
    const perform = engine.commands.at(-1);
    if (!perform || perform.command.type !== "performAction") {
      throw new Error("expected performAction command");
    }

    engine.eventQueue.push({
      type: "event",
      sequence: 2,
      epoch: "epoch-1",
      causeCommandId: perform.id,
      event: {
        type: "presentationContentReplaced",
        checkId: "dismiss-rematerialization",
        content: {
          documentRevision: "doc:0",
          status: "checking",
          progress: { completedUnitCount: 1, totalUnitCount: 3 },
          appearance: DEFAULT_PRESENTATION_APPEARANCE,
          interaction: DEFAULT_PRESENTATION_INTERACTION,
          suggestions: [],
        },
      },
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation).toMatchObject({
        state: {
          type: "checking",
          progress: { completedUnitCount: 1, totalUnitCount: 3 },
        },
        suggestions: [],
      }),
    );
    engine.eventQueue.push({
      type: "event",
      sequence: 3,
      epoch: "epoch-1",
      event: { type: "actionCompleted", actionId: perform.command.actionId },
    });
    await expect(dismissal).resolves.toEqual({ status: "completed" });
    engine.eventQueue.push({
      type: "event",
      sequence: 4,
      epoch: "epoch-1",
      event: {
        type: "presentationContentReplaced",
        checkId: "dismiss-rematerialization",
        content: {
          documentRevision: "doc:0",
          status: "checking",
          progress: { completedUnitCount: 2, totalUnitCount: 3 },
          appearance: DEFAULT_PRESENTATION_APPEARANCE,
          interaction: DEFAULT_PRESENTATION_INTERACTION,
          suggestions: [],
        },
      },
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "checking",
        progress: { completedUnitCount: 2, totalUnitCount: 3 },
      }),
    );
    engine.eventQueue.push({
      type: "event",
      sequence: 5,
      epoch: "epoch-1",
      event: completeLifecyclePresentation("active-check"),
    });

    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "complete",
        coverage: "full",
      }),
    );

    controller.abort();
    host.observations.close();
    await run;
  });

  it("keeps an active check live across reconnect after older Dismiss rematerializes it as complete", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link now"));
    const engine = new ReconnectingEngine();
    const integration = createRefineIntegration({
      enginePort: engine,
      reconnectDelayMs: 0,
    });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.sessions[0]?.commands).toHaveLength(1));

    const active = progressivePresentation("active-check", 1);
    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      event: {
        ...active,
        content: {
          ...active.content,
          suggestions: active.content.suggestions.map((suggestion) => ({
            ...suggestion,
            id: "dismiss-me",
            availableActions: ["dismiss"],
          })),
        },
      },
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.suggestions).toMatchObject([
        { id: "dismiss-me", availableActions: ["dismiss"] },
      ]),
    );
    const dismissal = host.currentActions?.dismiss("dismiss-me");
    if (!dismissal) {
      throw new Error("expected Dismiss action");
    }
    await vi.waitFor(() =>
      expect(engine.sessions[0]?.commands.at(-1)?.command.type).toBe(
        "performAction",
      ),
    );
    const perform = engine.sessions[0]?.commands.at(-1);
    if (!perform || perform.command.type !== "performAction") {
      throw new Error("expected performAction command");
    }
    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 2,
      epoch: "epoch-1",
      causeCommandId: perform.id,
      event: completeLifecyclePresentation("dismiss-complete"),
    });
    await vi.waitFor(() => {
      expect(host.currentPresentation).toMatchObject({
        state: { type: "complete", coverage: "full" },
        suggestions: [],
      });
      expect(engine.sessions[0]?.commands.map(({ command }) => command.type)).toEqual([
        "openDocument",
        "performAction",
      ]);
    });
    engine.sessions[0]?.events.push({
      type: "event",
      sequence: 3,
      epoch: "epoch-1",
      event: { type: "actionCompleted", actionId: perform.command.actionId },
    });
    await expect(dismissal).resolves.toEqual({ status: "completed" });
    engine.sessions[0]?.events.close();

    await vi.waitFor(() => {
      expect(engine.sessions).toHaveLength(2);
      expect(engine.sessions[1]?.commands.map(({ command }) => command.type)).toEqual([
        "openDocument",
      ]);
    });
    const reconnectOpen = engine.sessions[1]?.commands[0];
    if (!reconnectOpen) {
      throw new Error("expected reconnect openDocument command");
    }
    engine.sessions[1]?.events.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      causeCommandId: reconnectOpen.id,
      event: completeLifecyclePresentation("legacy-replay-check"),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.state).toEqual({
        type: "complete",
        coverage: "full",
      }),
    );

    engine.sessions[1]?.events.push({
      type: "event",
      sequence: 2,
      epoch: "epoch-1",
      event: suggestionPresentation("active-check", "full-result"),
    });
    await vi.waitFor(() =>
      expect(host.currentPresentation?.suggestions.map(({ id }) => id)).toEqual([
        "full-result",
      ]),
    );

    controller.abort();
    host.observations.close();
    engine.sessions[1]?.events.close();
    await run;
  });

  it("keeps the current presentation and action object usable when Report can retry", async () => {
    const host = new FakeHost(snapshot("doc:0", "create an link"));
    const engine = new FakeEngine();
    const integration = createRefineIntegration({ enginePort: engine });
    const controller = new AbortController();
    const run = integration.run({ host, signal: controller.signal });
    await vi.waitFor(() => expect(engine.commands).toHaveLength(1));
    const reportPresentation = suggestionPresentation("check-report", "report-me");
    engine.emit({
      ...reportPresentation,
      content: {
        ...reportPresentation.content,
        suggestions: reportPresentation.content.suggestions.map((suggestion) => ({
          ...suggestion,
          availableActions: ["report"],
        })),
      },
    });
    await vi.waitFor(() => expect(host.currentPresentation?.suggestions).toHaveLength(1));
    const cardActions = host.currentActions;
    if (!cardActions) {
      throw new Error("expected suggestion actions");
    }
    const presentationCount = host.presentations.length;

    const firstReport = cardActions.report("report-me");
    await vi.waitFor(() =>
      expect(
        engine.commands.filter(({ command }) => command.type === "performAction"),
      ).toHaveLength(1),
    );
    const firstPerform = engine.commands.find(
      ({ command }) => command.type === "performAction",
    )?.command;
    if (!firstPerform || firstPerform.type !== "performAction") {
      throw new Error("expected Report action");
    }
    engine.emit({
      type: "actionRejected",
      actionId: firstPerform.actionId,
      reason: "reportingUnavailable",
    });

    await expect(firstReport).resolves.toEqual({
      status: "unavailable",
      reason: "reportingUnavailable",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.presentations).toHaveLength(presentationCount);

    const retry = cardActions.report("report-me");
    await vi.waitFor(() =>
      expect(
        engine.commands.filter(({ command }) => command.type === "performAction"),
      ).toHaveLength(2),
    );
    const retryPerform = engine.commands.filter(
      ({ command }) => command.type === "performAction",
    ).at(-1)?.command;
    if (!retryPerform || retryPerform.type !== "performAction") {
      throw new Error("expected retried Report action");
    }
    engine.emit({ type: "actionCompleted", actionId: retryPerform.actionId });
    await expect(retry).resolves.toEqual({ status: "completed" });

    controller.abort();
    host.observations.close();
    await run;
  });

  it.each([
    {
      rejection: "stale" as const,
      expected: { status: "stale" as const },
    },
    {
      rejection: "engineUnavailable" as const,
      expected: {
        status: "unavailable" as const,
        reason: "engineUnavailable" as const,
      },
    },
  ])(
    "terminates Explain with a visible $rejection update when rejected before starting",
    async ({ rejection, expected }) => {
      const host = new FakeHost(snapshot("doc:0", "create an link"));
      const engine = new FakeEngine();
      const integration = createRefineIntegration({ enginePort: engine });
      const controller = new AbortController();
      const run = integration.run({ host, signal: controller.signal });
      await vi.waitFor(() => expect(engine.commands).toHaveLength(1));
      const explainPresentation = suggestionPresentation("check-explain", "explain-me");
      engine.emit({
        ...explainPresentation,
        content: {
          ...explainPresentation.content,
          suggestions: explainPresentation.content.suggestions.map((suggestion) => ({
            ...suggestion,
            availableActions: ["explain"],
          })),
        },
      });
      await vi.waitFor(() => expect(host.currentPresentation?.suggestions).toHaveLength(1));
      const explanation = host.currentActions
        ?.explain("explain-me")[Symbol.asyncIterator]();
      if (!explanation) {
        throw new Error("expected Explain action");
      }

      const terminal = explanation.next();
      await vi.waitFor(() =>
        expect(
          engine.commands.filter(({ command }) => command.type === "performAction"),
        ).toHaveLength(1),
      );
      const perform = engine.commands.find(
        ({ command }) => command.type === "performAction",
      )?.command;
      if (!perform || perform.type !== "performAction") {
        throw new Error("expected Explain action command");
      }
      engine.emit({
        type: "actionRejected",
        actionId: perform.actionId,
        reason: rejection,
      });

      await expect(terminal).resolves.toEqual({ done: false, value: expected });
      await expect(explanation.next()).resolves.toEqual({
        done: true,
        value: undefined,
      });

      controller.abort();
      host.observations.close();
      await run;
    },
  );

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
        interaction: DEFAULT_PRESENTATION_INTERACTION,
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

const alternateInteraction: PresentationInteraction = {
  quickApply: {
    enabled: false,
    applyKey: "rightShift",
    dismissKey: "leftControl",
    activationStyle: "highlightChanges",
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

  present(
    snapshot: PresentationSnapshot,
    actions: SuggestionActions,
  ): void | Promise<void> {
    this.presentations.push(snapshot);
    this.currentPresentation = snapshot;
    this.currentActions = actions;
  }
}

class BlockingCheckingHost extends FakeHost {
  private blockedChecking = false;
  private releaseBlockedChecking: (() => void) | undefined;

  get hasBlockedChecking(): boolean {
    return this.blockedChecking && this.releaseBlockedChecking !== undefined;
  }

  override async present(
    presentation: PresentationSnapshot,
    actions: SuggestionActions,
  ): Promise<void> {
    if (presentation.state.type === "checking" && !this.blockedChecking) {
      this.blockedChecking = true;
      await new Promise<void>((resolve) => {
        this.releaseBlockedChecking = resolve;
      });
      this.releaseBlockedChecking = undefined;
    }
    await super.present(presentation, actions);
  }

  releaseChecking(): void {
    this.releaseBlockedChecking?.();
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
      send: async (command, commandId): Promise<CommandReceipt> => {
        this.sequence += 1;
        const id = commandId ?? `command-${this.sequence}`;
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
  eventsRead = 0;
  private commandSequence = 0;
  private eventSequence = 0;

  connect(): Promise<RefineTransportSession> {
    return Promise.resolve({
      serverEpoch: "epoch-1",
      runResumed: false,
      send: async (command, commandId): Promise<CommandReceipt> => {
        this.commandSequence += 1;
        const id = commandId ?? `command-${this.commandSequence}`;
        this.commands.push({ command, id });
        return { sequence: this.commandSequence, id };
      },
      events: () => this.readEvents(),
      close: async () => this.eventQueue.close(),
    });
  }

  emit(
    event: ServerEventEnvelope["event"],
    causeCommandId?: string,
  ): void {
    this.eventSequence += 1;
    this.eventQueue.push({
      type: "event",
      sequence: this.eventSequence,
      epoch: "epoch-1",
      ...(causeCommandId === undefined ? {} : { causeCommandId }),
      event,
    });
  }

  private async *readEvents(): AsyncIterable<ServerEventEnvelope> {
    for await (const event of this.eventQueue) {
      this.eventsRead += 1;
      yield event;
    }
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
      interaction: DEFAULT_PRESENTATION_INTERACTION,
      suggestions: [
        {
          id: suggestionId,
          sourceId: "document",
          kind: "grammar",
          attribution: TEST_ATTRIBUTION,
          activationRange: { location: 7, length: 2 },
          highlightRanges: [{ location: 7, length: 2 }],
          diff: [],
          availableActions: ["apply"],
        },
      ],
    },
  };
}

function checkingLifecyclePresentation(
  checkId: string,
  progress?: {
    readonly completedUnitCount: number;
    readonly totalUnitCount: number;
  },
): Extract<
  ServerEventEnvelope["event"],
  { readonly type: "presentationContentReplaced" }
> {
  return {
    type: "presentationContentReplaced",
    checkId,
    content: {
      documentRevision: "doc:0",
      status: "checking",
      ...(progress === undefined ? {} : { progress }),
      appearance: DEFAULT_PRESENTATION_APPEARANCE,
      interaction: DEFAULT_PRESENTATION_INTERACTION,
      suggestions: [],
    },
  };
}

function completeLifecyclePresentation(
  checkId: string,
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
      interaction: DEFAULT_PRESENTATION_INTERACTION,
      suggestions: [],
    },
  };
}

function pendingLifecyclePresentation(
  checkId: string,
): Extract<
  ServerEventEnvelope["event"],
  { readonly type: "presentationContentReplaced" }
> {
  return {
    type: "presentationContentReplaced",
    checkId,
    content: {
      documentRevision: "doc:0",
      status: "pending",
      appearance: DEFAULT_PRESENTATION_APPEARANCE,
      interaction: DEFAULT_PRESENTATION_INTERACTION,
      suggestions: [],
    },
  };
}

function unavailableLifecyclePresentation(
  checkId: string,
): Extract<
  ServerEventEnvelope["event"],
  { readonly type: "presentationContentReplaced" }
> {
  return {
    type: "presentationContentReplaced",
    checkId,
    content: {
      documentRevision: "doc:0",
      status: "unavailable",
      unavailableReason: "checkFailed",
      appearance: DEFAULT_PRESENTATION_APPEARANCE,
      interaction: DEFAULT_PRESENTATION_INTERACTION,
      suggestions: [],
    },
  };
}

function progressivePresentation(
  checkId: string,
  completedUnitCount: number,
): Extract<
  ServerEventEnvelope["event"],
  { readonly type: "presentationContentReplaced" }
> {
  const base = suggestionPresentation(checkId, "sentence-1")
    .content.suggestions[0]!;
  const ranges = [
    { location: 7, length: 2 },
    { location: 10, length: 4 },
    { location: 15, length: 3 },
  ];
  return {
    type: "presentationContentReplaced",
    checkId,
    content: {
      documentRevision: "doc:0",
      status: "checking",
      progress: { completedUnitCount, totalUnitCount: 3 },
      appearance: DEFAULT_PRESENTATION_APPEARANCE,
      interaction: DEFAULT_PRESENTATION_INTERACTION,
      suggestions: ranges.slice(0, completedUnitCount).map((range, index) => ({
        ...base,
        id: `sentence-${index + 1}`,
        highlightRanges: [range],
      })),
    },
  };
}
