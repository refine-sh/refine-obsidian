// @vitest-environment jsdom

import { history, undo } from "@codemirror/commands";
import { EditorState, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRefineIntegration } from "../../src/integration/refine-integration";
import type {
  HostApplyOutcome,
  HostApplyRequest,
  PresentationSnapshot,
  SuggestionActions,
  UTF16Range,
} from "../../src/integration/types";
import { ObsidianWritingHost } from "../../src/obsidian/host";
import { FakeEngine, suggestionPresentation } from "../helpers/fake-engine";

/**
 * Cross-repo contract: each fixture mirrors a sanitized apply-failure
 * telemetry report family (5, 20, and 21) from the Refine app. The
 * `scenarioDigest` hex values are pinned on the app side at
 * `RefineTests/Fixtures/ApplyFailures/integration-report-{5,20,21}.json`, so
 * the two repositories must change a digest together or not at all.
 */
interface ApplyFixture {
  /** Apply-failure telemetry report family this fixture mirrors. */
  readonly family: "5" | "20" | "21";
  readonly sessionId: string;
  readonly source: string;
  readonly request: Omit<HostApplyRequest, "expectedRevision">;
  readonly expected: string;
  readonly activationRange: UTF16Range;
  /** Pinned by the Refine app repo; see the contract note above. */
  readonly scenarioDigest: string;
}

const applyFixtures: readonly ApplyFixture[] = [
  {
    family: "5",
    sessionId: "report-family-5",
    source: "[create an link](URL)or",
    request: {
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
    },
    expected: "[create a link](URL) or",
    activationRange: { location: 8, length: 13 },
    scenarioDigest:
      "efa9c0803ebaa91c635dec5fee7f1cdc835f7b4466327d795375d161b3e383cf",
  },
  syntheticRangeFixture({
    family: "20",
    sourceLength: 275,
    location: 30,
    length: 41,
    replacementLength: 42,
    prefixSeed: "# Synthetic 😀\n",
    scenarioDigest:
      "f0bcf362201933e4c67613bb630b7fb10f8dbadcd9649d745bdcbc1f8f891f4a",
  }),
  syntheticRangeFixture({
    family: "21",
    sourceLength: 277,
    location: 98,
    length: 42,
    replacementLength: 43,
    prefixSeed: "## Synthetic e\u0301\n",
    scenarioDigest:
      "6a969bfb3951cad76b729a083876a512452d0f56884c2a07ef9a2377b2f96282",
  }),
];

describe("Obsidian host-integration Apply", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const view of views) {
      view.destroy();
    }
    views.length = 0;
    document.body.replaceChildren();
  });

  it.each(applyFixtures)(
    "applies sanitized report family $family atomically and keeps one undo unit",
    async (fixture) => {
      let documentTransactions = 0;
      let insideEditorDispatch = false;
      const view = createView(
        fixture.source,
        [
          history(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              documentTransactions += 1;
            }
          }),
        ],
        (transactions, editor) => {
          insideEditorDispatch = true;
          try {
            editor.update(transactions);
          } finally {
            insideEditorDispatch = false;
          }
        },
      );
      const host = new CapturingObsidianHost(view, {
        sessionId: fixture.sessionId,
      });
      const applyRequests = vi.spyOn(host, "apply");
      const engine = new FakeEngine();
      const controller = new AbortController();
      const run = createRefineIntegration({ enginePort: engine }).run({
        host,
        signal: controller.signal,
      });

      try {
        const open = await engine.waitForCommand("openDocument");
        expect(open.command).toEqual({
          type: "openDocument",
          snapshot: {
            revision: `${fixture.sessionId}:0`,
            sources: [
              {
                sourceId: "document",
                sourceSyntax: "markdownDocumentHardLineBreaks",
                text: fixture.source,
              },
            ],
          },
        });
        engine.emit(
          {
            type: "documentAccepted",
            revision: `${fixture.sessionId}:0`,
          },
          open.id,
        );
        engine.emit(
          suggestionPresentation(
            `check-report-family-${fixture.family}`,
            `report-family-${fixture.family}`,
            {
              revision: `${fixture.sessionId}:0`,
              activationRange: fixture.activationRange,
            },
          ),
        );

        await vi.waitFor(() =>
          expect(host.currentPresentation?.suggestions).toHaveLength(1),
        );
        const action = host.currentActions?.apply(
          `report-family-${fixture.family}`,
        );
        if (!action) {
          throw new Error("expected an Apply action");
        }
        const perform = await engine.waitForCommand("performAction");
        if (perform.command.type !== "performAction") {
          throw new Error("expected performAction command");
        }

        const request: HostApplyRequest = {
          expectedRevision: `${fixture.sessionId}:0`,
          ...fixture.request,
        };
        // The native-write probe is live for the whole apply exchange so the
        // digest's native counters are measured, not asserted by fiat.
        const probe = installNativeWriteProbe(() => insideEditorDispatch);
        try {
          engine.emit({
            type: "applyRequested",
            actionId: perform.command.actionId,
            transactionId: `transaction-${fixture.family}`,
            request,
          });
          await vi.waitFor(() =>
            expect(engine.commandsOfType("completeApply")).toHaveLength(1),
          );
        } finally {
          probe.uninstall();
        }
        expect(view.state.doc.toString()).toBe(fixture.expected);
        expect(documentTransactions).toBe(1);
        expect(engine.commandsOfType("completeApply")[0]?.command).toEqual({
          type: "completeApply",
          transactionId: `transaction-${fixture.family}`,
          outcome: {
            status: "applied",
            snapshot: {
              revision: `${fixture.sessionId}:1`,
              sources: [
                {
                  sourceId: "document",
                  sourceSyntax: "markdownDocumentHardLineBreaks",
                  text: fixture.expected,
                },
              ],
            },
          },
        });

        // Scenario measurements, all read back from the run itself.
        const completions = engine.commandsOfType("completeApply");
        const completionOutcome = completions[0]?.command.outcome;
        const documentMutationCount = documentTransactions;
        const completionReceiptCount = completions.length;
        const completionStatus = completionOutcome?.status ?? "missing";
        const completionSnapshot =
          completionOutcome !== undefined && "snapshot" in completionOutcome
            ? completionOutcome.snapshot
            : undefined;
        const authoritativeChangedRevisionReadback =
          completionSnapshot !== undefined &&
          completionSnapshot.revision !== request.expectedRevision &&
          (await host.validateRevision(completionSnapshot.revision)).status ===
            "current";

        engine.emit({
          type: "actionCompleted",
          actionId: perform.command.actionId,
        });
        await expect(action).resolves.toEqual({ status: "completed" });

        const undoApplied = undo(view);
        const undoRestoresSource =
          undoApplied && view.state.doc.toString() === fixture.source;
        expect(undoApplied).toBe(true);
        expect(view.state.doc.toString()).toBe(fixture.source);
        expect(documentTransactions).toBe(2);
        await expect(host.validateRevision(`${fixture.sessionId}:0`)).resolves.toEqual({
          status: "stale",
          snapshot: {
            revision: `${fixture.sessionId}:2`,
            sources: [
              expect.objectContaining({
                sourceSyntax: "markdownDocumentHardLineBreaks",
                text: fixture.source,
              }),
            ],
          },
        });

        const staleOutcome = await host.apply(request);
        const staleRevisionRejected =
          staleOutcome.status === "rejected" &&
          staleOutcome.reason === "staleRevision" &&
          view.state.doc.toString() === fixture.source;
        expect(staleOutcome).toEqual({
          status: "rejected",
          reason: "staleRevision",
          snapshot: {
            revision: `${fixture.sessionId}:2`,
            sources: [
              {
                sourceId: "document",
                sourceSyntax: "markdownDocumentHardLineBreaks",
                text: fixture.source,
              },
            ],
          },
        });
        expect(applyRequests).toHaveBeenCalledTimes(2);
        expect(view.state.doc.toString()).toBe(fixture.source);
        expect(documentTransactions).toBe(2);

        expect(
          integrationScenarioDigest(fixture, {
            documentMutationCount,
            completionReceiptCount,
            authoritativeChangedRevisionReadback,
            nativeSelectionWriteCount: probe.selectionWrites(),
            nativePasteCount: probe.pastes(),
            completionStatus,
            undoRestoresSource,
            staleRevisionRejected,
          }),
        ).toBe(fixture.scenarioDigest);
      } finally {
        controller.abort();
        await run;
        host.close();
      }
    },
  );

  it("does not dispatch again after an indeterminate CodeMirror mutation", async () => {
    const source = "create an link";
    const expected = "create a link";
    let failAfterNextDocumentMutation = false;
    let documentTransactions = 0;
    const view = createView(
      source,
      [
        history(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            documentTransactions += 1;
          }
        }),
      ],
      (transactions, editor) => {
        editor.update(transactions);
        if (
          failAfterNextDocumentMutation &&
          transactions.some((transaction) => transaction.docChanged)
        ) {
          failAfterNextDocumentMutation = false;
          throw new Error("synthetic post-dispatch uncertainty");
        }
      },
    );
    const host = new CapturingObsidianHost(view, {
      sessionId: "indeterminate",
    });
    const apply = vi.spyOn(host, "apply");
    const engine = new FakeEngine();
    const controller = new AbortController();
    const run = createRefineIntegration({ enginePort: engine }).run({
      host,
      signal: controller.signal,
    });

    try {
      const open = await engine.waitForCommand("openDocument");
      engine.emit(
        { type: "documentAccepted", revision: "indeterminate:0" },
        open.id,
      );
      engine.emit(
        suggestionPresentation(
          "check-indeterminate-suggestion",
          "indeterminate-suggestion",
          {
            revision: "indeterminate:0",
            activationRange: { location: 7, length: 2 },
          },
        ),
      );
      await vi.waitFor(() =>
        expect(host.currentPresentation?.suggestions).toHaveLength(1),
      );
      const action = host.currentActions?.apply("indeterminate-suggestion");
      if (!action) {
        throw new Error("expected an Apply action");
      }
      const perform = await engine.waitForCommand("performAction");
      if (perform.command.type !== "performAction") {
        throw new Error("expected performAction command");
      }
      const applyRequested = {
        type: "applyRequested" as const,
        actionId: perform.command.actionId,
        transactionId: "indeterminate-transaction",
        request: {
          expectedRevision: "indeterminate:0",
          sourceId: "document",
          edits: [
            {
              range: { location: 7, length: 2 },
              expectedText: "an",
              replacement: "a",
            },
          ],
        },
      };

      failAfterNextDocumentMutation = true;
      engine.emit(applyRequested);
      await vi.waitFor(() =>
        expect(engine.commandsOfType("completeApply")).toHaveLength(1),
      );
      expect(view.state.doc.toString()).toBe(expected);
      expect(documentTransactions).toBe(1);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(engine.commandsOfType("completeApply")[0]?.command).toMatchObject({
        transactionId: "indeterminate-transaction",
        outcome: {
          status: "indeterminate",
          snapshot: {
            revision: "indeterminate:1",
            sources: [{ text: expected }],
          },
        },
      });

      engine.emit(applyRequested);
      await vi.waitFor(() =>
        expect(engine.commandsOfType("completeApply")).toHaveLength(2),
      );
      expect(apply).toHaveBeenCalledTimes(1);
      expect(documentTransactions).toBe(1);
      expect(
        engine.commandsOfType("completeApply").map(({ command }) => command),
      ).toEqual([
        expect.objectContaining({
          transactionId: "indeterminate-transaction",
          outcome: expect.objectContaining({ status: "indeterminate" }),
        }),
        expect.objectContaining({
          transactionId: "indeterminate-transaction",
          outcome: expect.objectContaining({ status: "indeterminate" }),
        }),
      ]);

      engine.emit({
        type: "actionRejected",
        actionId: perform.command.actionId,
        reason: "mutationIndeterminate",
      });
      await expect(action).resolves.toEqual({
        status: "unavailable",
        reason: "mutationIndeterminate",
      });
    } finally {
      controller.abort();
      await run;
      host.close();
    }
  });

  it("rejects an apply whose expected text disagrees with the live document", async () => {
    const source = "create an link";
    let documentTransactions = 0;
    const view = createView(source, [
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          documentTransactions += 1;
        }
      }),
    ]);
    const host = new CapturingObsidianHost(view, { sessionId: "mismatch" });
    const apply = vi.spyOn(host, "apply");
    const engine = new FakeEngine();
    const controller = new AbortController();
    const run = createRefineIntegration({ enginePort: engine }).run({
      host,
      signal: controller.signal,
    });

    try {
      const open = await engine.waitForCommand("openDocument");
      engine.emit(
        { type: "documentAccepted", revision: "mismatch:0" },
        open.id,
      );
      engine.emit(
        suggestionPresentation("check-mismatch", "mismatch-suggestion", {
          revision: "mismatch:0",
          activationRange: { location: 7, length: 2 },
        }),
      );
      await vi.waitFor(() =>
        expect(host.currentPresentation?.suggestions).toHaveLength(1),
      );
      const action = host.currentActions?.apply("mismatch-suggestion");
      if (!action) {
        throw new Error("expected an Apply action");
      }
      const perform = await engine.waitForCommand("performAction");

      engine.emit({
        type: "applyRequested",
        actionId: perform.command.actionId,
        transactionId: "mismatch-transaction",
        request: {
          expectedRevision: "mismatch:0",
          sourceId: "document",
          edits: [
            {
              // The live document reads "an" at this range; the engine's
              // expectation disagrees, so the host must refuse to mutate.
              range: { location: 7, length: 2 },
              expectedText: "aa",
              replacement: "a",
            },
          ],
        },
      });
      await vi.waitFor(() =>
        expect(engine.commandsOfType("completeApply")).toHaveLength(1),
      );

      expect(engine.commandsOfType("completeApply")[0]?.command).toEqual({
        type: "completeApply",
        transactionId: "mismatch-transaction",
        outcome: {
          status: "rejected",
          reason: "textMismatch",
          snapshot: {
            revision: "mismatch:0",
            sources: [
              {
                sourceId: "document",
                sourceSyntax: "markdownDocumentHardLineBreaks",
                text: source,
              },
            ],
          },
        },
      });
      expect(apply).toHaveBeenCalledOnce();
      expect(view.state.doc.toString()).toBe(source);
      expect(documentTransactions).toBe(0);

      engine.emit({
        type: "actionRejected",
        actionId: perform.command.actionId,
        reason: "applyNotProven",
      });
      await expect(action).resolves.toEqual({
        status: "unavailable",
        reason: "applyNotProven",
      });
    } finally {
      controller.abort();
      await run;
      host.close();
    }
  });

  it("rejects a stale apply after a user edit lands between presentation and apply", async () => {
    const source = "create an link";
    const editedSource = "Note: create an link";
    let documentTransactions = 0;
    const view = createView(source, [
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          documentTransactions += 1;
        }
      }),
    ]);
    const host = new CapturingObsidianHost(view, { sessionId: "concurrent" });
    const apply = vi.spyOn(host, "apply");
    const engine = new FakeEngine();
    const controller = new AbortController();
    const run = createRefineIntegration({ enginePort: engine }).run({
      host,
      signal: controller.signal,
    });

    try {
      const open = await engine.waitForCommand("openDocument");
      engine.emit(
        { type: "documentAccepted", revision: "concurrent:0" },
        open.id,
      );
      engine.emit(
        suggestionPresentation("check-concurrent", "concurrent-suggestion", {
          revision: "concurrent:0",
          activationRange: { location: 7, length: 2 },
        }),
      );
      await vi.waitFor(() =>
        expect(host.currentPresentation?.suggestions).toHaveLength(1),
      );
      const action = host.currentActions?.apply("concurrent-suggestion");
      if (!action) {
        throw new Error("expected an Apply action");
      }
      const perform = await engine.waitForCommand("performAction");

      // A genuine user edit between presentation and apply advances the
      // authoritative revision before the engine's apply request arrives.
      view.dispatch({
        changes: { from: 0, insert: "Note: " },
        userEvent: "input.type",
      });
      expect(view.state.doc.toString()).toBe(editedSource);
      const replace = await engine.waitForCommand("replaceDocument");
      expect(replace.command.snapshot).toEqual({
        revision: "concurrent:1",
        sources: [
          {
            sourceId: "document",
            sourceSyntax: "markdownDocumentHardLineBreaks",
            text: editedSource,
          },
        ],
      });
      await expect(action).resolves.toEqual({ status: "stale" });

      engine.emit({
        type: "applyRequested",
        actionId: perform.command.actionId,
        transactionId: "concurrent-transaction",
        request: {
          expectedRevision: "concurrent:0",
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
        expect(engine.commandsOfType("completeApply")).toHaveLength(1),
      );

      expect(engine.commandsOfType("completeApply")[0]?.command).toEqual({
        type: "completeApply",
        transactionId: "concurrent-transaction",
        outcome: {
          status: "rejected",
          reason: "staleRevision",
          snapshot: {
            revision: "concurrent:1",
            sources: [
              {
                sourceId: "document",
                sourceSyntax: "markdownDocumentHardLineBreaks",
                text: editedSource,
              },
            ],
          },
        },
      });
      // No fuzzy relocation: the host is never asked to mutate, and the
      // user's edit is preserved verbatim.
      expect(apply).not.toHaveBeenCalled();
      expect(view.state.doc.toString()).toBe(editedSource);
      expect(documentTransactions).toBe(1);
    } finally {
      controller.abort();
      await run;
      host.close();
    }
  });

  it("maps a host's unsupported nonAtomic refusal to the completeApply failure receipt", async () => {
    const source = "create an link";
    let documentTransactions = 0;
    const view = createView(source, [
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          documentTransactions += 1;
        }
      }),
    ]);
    const host = new NonAtomicRefusingHostStub(view, {
      sessionId: "non-atomic",
    });
    const apply = vi.spyOn(host, "apply");
    const engine = new FakeEngine();
    const controller = new AbortController();
    const run = createRefineIntegration({ enginePort: engine }).run({
      host,
      signal: controller.signal,
    });

    try {
      const open = await engine.waitForCommand("openDocument");
      engine.emit(
        { type: "documentAccepted", revision: "non-atomic:0" },
        open.id,
      );
      engine.emit(
        suggestionPresentation(
          "check-non-atomic-suggestion",
          "non-atomic-suggestion",
          {
            revision: "non-atomic:0",
            activationRange: { location: 7, length: 2 },
          },
        ),
      );
      await vi.waitFor(() =>
        expect(host.currentPresentation?.suggestions).toHaveLength(1),
      );

      const action = host.currentActions?.apply("non-atomic-suggestion");
      if (!action) {
        throw new Error("expected an Apply action");
      }
      const perform = await engine.waitForCommand("performAction");
      if (perform.command.type !== "performAction") {
        throw new Error("expected performAction command");
      }
      await vi.waitFor(() =>
        expect(
          host.currentPresentation?.suggestions[0]?.availableActions,
        ).toEqual([]),
      );

      engine.emit({
        type: "applyRequested",
        actionId: perform.command.actionId,
        transactionId: "non-atomic-transaction",
        request: {
          expectedRevision: "non-atomic:0",
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
        expect(engine.commandsOfType("completeApply")).toHaveLength(1),
      );

      expect(engine.commandsOfType("completeApply")[0]?.command).toEqual({
        type: "completeApply",
        transactionId: "non-atomic-transaction",
        outcome: { status: "unsupported", reason: "nonAtomic" },
      });
      // Mapping-side assertions only: the stub host never mutates, so these
      // verify that the integration layer adds no mutation or host
      // redispatch of its own around the refusal — not the real host's
      // refusal behavior.
      expect(apply).toHaveBeenCalledOnce();
      expect(view.state.doc.toString()).toBe(source);
      expect(documentTransactions).toBe(0);

      engine.emit({
        type: "actionRejected",
        actionId: perform.command.actionId,
        reason: "nonAtomic",
      });
      await expect(action).resolves.toEqual({
        status: "unavailable",
        reason: "nonAtomic",
      });
      await vi.waitFor(() =>
        expect(
          host.currentPresentation?.suggestions[0]?.availableActions,
        ).toEqual(["apply"]),
      );

      expect(engine.commandsOfType("performAction")).toHaveLength(1);
      expect(engine.commandsOfType("completeApply")).toHaveLength(1);
      expect(apply).toHaveBeenCalledOnce();
      expect(view.state.doc.toString()).toBe(source);
      expect(documentTransactions).toBe(0);
    } finally {
      controller.abort();
      await run;
      host.close();
    }
  });

  it("maps a read-only surface refusal through the integration to a completeApply failure", async () => {
    const source = "synthetic draft";
    let documentTransactions = 0;
    const view = createView(source, [
      EditorView.editable.of(false),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          documentTransactions += 1;
        }
      }),
    ]);
    const host = new CapturingObsidianHost(view, {
      sessionId: "read-only-seam",
    });
    const apply = vi.spyOn(host, "apply");
    const engine = new FakeEngine();
    const controller = new AbortController();
    const run = createRefineIntegration({ enginePort: engine }).run({
      host,
      signal: controller.signal,
    });

    try {
      const open = await engine.waitForCommand("openDocument");
      engine.emit(
        { type: "documentAccepted", revision: "read-only-seam:0" },
        open.id,
      );
      engine.emit(
        suggestionPresentation("check-read-only", "read-only-suggestion", {
          revision: "read-only-seam:0",
          activationRange: { location: 10, length: 5 },
        }),
      );
      await vi.waitFor(() =>
        expect(host.currentPresentation?.suggestions).toHaveLength(1),
      );
      const action = host.currentActions?.apply("read-only-suggestion");
      if (!action) {
        throw new Error("expected an Apply action");
      }
      const perform = await engine.waitForCommand("performAction");

      engine.emit({
        type: "applyRequested",
        actionId: perform.command.actionId,
        transactionId: "read-only-transaction",
        request: {
          expectedRevision: "read-only-seam:0",
          sourceId: "document",
          edits: [
            {
              range: { location: 10, length: 5 },
              expectedText: "draft",
              replacement: "revision",
            },
          ],
        },
      });
      await vi.waitFor(() =>
        expect(engine.commandsOfType("completeApply")).toHaveLength(1),
      );

      expect(engine.commandsOfType("completeApply")[0]?.command).toEqual({
        type: "completeApply",
        transactionId: "read-only-transaction",
        outcome: {
          status: "unsupported",
          reason: "readOnly",
          snapshot: {
            revision: "read-only-seam:0",
            sources: [
              {
                sourceId: "document",
                sourceSyntax: "markdownDocumentHardLineBreaks",
                text: source,
              },
            ],
          },
        },
      });
      expect(apply).toHaveBeenCalledOnce();
      expect(view.state.doc.toString()).toBe(source);
      expect(documentTransactions).toBe(0);

      engine.emit({
        type: "actionRejected",
        actionId: perform.command.actionId,
        reason: "readOnly",
      });
      await expect(action).resolves.toEqual({
        status: "unavailable",
        reason: "readOnly",
      });
    } finally {
      controller.abort();
      await run;
      host.close();
    }
  });

  it("reports read-only and closed hosts without dispatching a mutation", async () => {
    const source = "synthetic draft";
    let documentTransactions = 0;
    const view = createView(source, [
      EditorView.editable.of(false),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          documentTransactions += 1;
        }
      }),
    ]);
    const host = new ObsidianWritingHost(view, { sessionId: "read-only" });
    const request: HostApplyRequest = {
      expectedRevision: "read-only:0",
      sourceId: "document",
      edits: [
        {
          range: { location: 10, length: 5 },
          expectedText: "draft",
          replacement: "revision",
        },
      ],
    };

    await expect(host.apply(request)).resolves.toEqual({
      status: "unsupported",
      reason: "readOnly",
      snapshot: {
        revision: "read-only:0",
        sources: [
          {
            sourceId: "document",
            sourceSyntax: "markdownDocumentHardLineBreaks",
            text: source,
          },
        ],
      },
    });
    expect(documentTransactions).toBe(0);

    host.close();
    await expect(host.apply(request)).resolves.toEqual({
      status: "unavailable",
    });
    expect(view.state.doc.toString()).toBe(source);
    expect(documentTransactions).toBe(0);
  });

  function createView(
    doc: string,
    extensions: readonly import("@codemirror/state").Extension[],
    dispatchTransactions?: (
      transactions: readonly Transaction[],
      view: EditorView,
    ) => void,
  ): EditorView {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions }),
      ...(dispatchTransactions === undefined ? {} : { dispatchTransactions }),
    });
    views.push(view);
    return view;
  }
});

class CapturingObsidianHost extends ObsidianWritingHost {
  currentPresentation: PresentationSnapshot | undefined;
  currentActions: SuggestionActions | undefined;

  override present(
    snapshot: PresentationSnapshot,
    actions: SuggestionActions,
  ): void {
    this.currentPresentation = snapshot;
    this.currentActions = actions;
    super.present(snapshot, actions);
  }
}

// The production ObsidianWritingHost has no nonAtomic path and never emits
// unsupported(nonAtomic). This stub cans the refusal so the test above can
// exercise only the integration-layer mapping seam from a host refusal to
// the engine receipt; it is not verification of the real host.
class NonAtomicRefusingHostStub extends CapturingObsidianHost {
  override apply(_request: HostApplyRequest): Promise<HostApplyOutcome> {
    return Promise.resolve({ status: "unsupported", reason: "nonAtomic" });
  }
}

function syntheticRangeFixture(input: {
  readonly family: "20" | "21";
  readonly sourceLength: number;
  readonly location: number;
  readonly length: number;
  readonly replacementLength: number;
  readonly prefixSeed: string;
  readonly scenarioDigest: string;
}): ApplyFixture {
  if (input.prefixSeed.length > input.location) {
    throw new Error("synthetic prefix exceeds the captured edit location");
  }
  const suffixLength = input.sourceLength - input.location - input.length;
  if (suffixLength < 0) {
    throw new Error("synthetic edit exceeds the captured source length");
  }
  const prefix = `${input.prefixSeed}${"p".repeat(
    input.location - input.prefixSeed.length,
  )}`;
  const expectedText = "q".repeat(input.length);
  const replacement = "r".repeat(input.replacementLength);
  const suffix = "s".repeat(suffixLength);
  const source = `${prefix}${expectedText}${suffix}`;
  return {
    family: input.family,
    sessionId: `report-family-${input.family}`,
    source,
    request: {
      sourceId: "document",
      edits: [
        {
          range: { location: input.location, length: input.length },
          expectedText,
          replacement,
        },
      ],
    },
    expected: `${prefix}${replacement}${suffix}`,
    activationRange: { location: input.location, length: input.length },
    scenarioDigest: input.scenarioDigest,
  };
}

/** Observations gathered while the fixture's apply scenario actually ran. */
interface IntegrationApplyMeasurements {
  readonly documentMutationCount: number;
  readonly completionReceiptCount: number;
  readonly authoritativeChangedRevisionReadback: boolean;
  readonly nativeSelectionWriteCount: number;
  readonly nativePasteCount: number;
  readonly completionStatus: string;
  readonly undoRestoresSource: boolean;
  readonly staleRevisionRejected: boolean;
}

/**
 * Folds the fixture geometry and the measured run outcomes into the
 * cross-repo scenario digest. Every trailing line is derived from what the
 * test observed during the run, so the digest reproduces the pinned hex only
 * when the run genuinely behaved as attested.
 */
function integrationScenarioDigest(
  fixture: ApplyFixture,
  measurements: IntegrationApplyMeasurements,
): string {
  const lines = [
    "refine-integration-apply-scenario-v1",
    `caseID=report-family-${fixture.family}`,
    `reportIndex=${fixture.family}`,
    "route=hostIntegration",
    "seam=integrationApply",
    "protocolVersion=1.0",
    "sourceSyntax=markdownDocumentHardLineBreaks",
    `baseUTF16Length=${fixture.source.length}`,
    `editCount=${fixture.request.edits.length}`,
  ];
  fixture.request.edits.forEach((edit, index) => {
    lines.push(
      `edit[${index}].range=${edit.range.location}:${edit.range.length}`,
      `edit[${index}].expectedUTF16=${normalizedUTF16Hex(
        edit.expectedText,
        "e",
      )}`,
      `edit[${index}].replacementUTF16=${normalizedUTF16Hex(
        edit.replacement,
        "r",
      )}`,
    );
  });
  lines.push(
    `finalUTF16Length=${fixture.expected.length}`,
    `documentMutationCount=${measurements.documentMutationCount}`,
    `completionReceiptCount=${measurements.completionReceiptCount}`,
    `authoritativeChangedRevisionReadback=${measurements.authoritativeChangedRevisionReadback}`,
    `nativeSelectionWriteCount=${measurements.nativeSelectionWriteCount}`,
    `nativePasteCount=${measurements.nativePasteCount}`,
    `completionStatus=${measurements.completionStatus}`,
    `undoRestoresSource=${measurements.undoRestoresSource}`,
    `staleRevisionRejected=${measurements.staleRevisionRejected}`,
  );
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function normalizedUTF16Hex(text: string, token: "e" | "r"): string {
  const normalized = /^\s*$/u.test(text) ? text : token.repeat(text.length);
  let result = "";
  for (let index = 0; index < normalized.length; index += 1) {
    result += normalized.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return result;
}

interface NativeWriteProbe {
  readonly selectionWrites: () => number;
  readonly pastes: () => number;
  readonly uninstall: () => void;
}

const SELECTION_MUTATORS = [
  "addRange",
  "collapse",
  "collapseToEnd",
  "collapseToStart",
  "deleteFromDocument",
  "empty",
  "extend",
  "removeAllRanges",
  "removeRange",
  "selectAllChildren",
  "setBaseAndExtent",
  "setPosition",
] as const;

/**
 * Measures the native editing side channels an Apply is attested not to use:
 * DOM Selection mutation APIs, `document.execCommand`, and paste-event
 * dispatch. Selection writes CodeMirror performs while flushing the host's
 * own transaction dispatch are excluded — the contract under test is that
 * Apply mutates the document through exactly one CodeMirror transaction and
 * never through native selection writes or paste emulation. This is the
 * strongest honest measurement jsdom allows; real WebViews add input-event
 * channels jsdom does not implement.
 */
function installNativeWriteProbe(
  isInsideEditorDispatch: () => boolean,
): NativeWriteProbe {
  let selectionWrites = 0;
  let pastes = 0;
  const restorers: (() => void)[] = [];

  const selectionPrototype =
    typeof Selection === "undefined"
      ? undefined
      : (Selection.prototype as unknown as Record<string, unknown>);
  if (selectionPrototype) {
    for (const method of SELECTION_MUTATORS) {
      const original = selectionPrototype[method];
      if (typeof original !== "function") {
        continue;
      }
      selectionPrototype[method] = function (
        this: unknown,
        ...args: unknown[]
      ): unknown {
        if (!isInsideEditorDispatch()) {
          selectionWrites += 1;
        }
        return (original as (...inner: unknown[]) => unknown).apply(this, args);
      };
      restorers.push(() => {
        selectionPrototype[method] = original;
      });
    }
  }

  const documentRecord = document as unknown as Record<string, unknown>;
  const originalExecCommand = documentRecord["execCommand"];
  documentRecord["execCommand"] = (...args: unknown[]): boolean => {
    const [commandId] = args;
    if (!isInsideEditorDispatch()) {
      if (typeof commandId === "string" && commandId.toLowerCase() === "paste") {
        pastes += 1;
      } else {
        // Non-paste commands still count: execCommand is a native write
        // channel that bypasses the CodeMirror transaction seam either way.
        selectionWrites += 1;
      }
    }
    return typeof originalExecCommand === "function"
      ? Boolean(
          (originalExecCommand as (...inner: unknown[]) => unknown).apply(
            document,
            args,
          ),
        )
      : false;
  };
  restorers.push(() => {
    if (originalExecCommand === undefined) {
      Reflect.deleteProperty(documentRecord, "execCommand");
    } else {
      documentRecord["execCommand"] = originalExecCommand;
    }
  });

  const countPaste = (): void => {
    pastes += 1;
  };
  // Capture phase, so a synthesized paste is counted even when a handler
  // stops its propagation before it bubbles.
  document.addEventListener("paste", countPaste, true);
  restorers.push(() => {
    document.removeEventListener("paste", countPaste, true);
  });

  return {
    selectionWrites: () => selectionWrites,
    pastes: () => pastes,
    uninstall: () => {
      for (const restore of restorers.splice(0).reverse()) {
        restore();
      }
    },
  };
}
