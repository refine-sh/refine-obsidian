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
} from "../../src/integration/types";
import {
  DEFAULT_PRESENTATION_APPEARANCE,
  DEFAULT_PRESENTATION_INTERACTION,
} from "../../src/integration/types";
import { ObsidianWritingHost } from "../../src/obsidian/host";
import { AsyncQueue } from "../../src/shared/async-queue";
import type {
  CommandReceipt,
  RefineTransportSession,
} from "../../src/transport/refine-transport";
import type {
  ClientCommand,
  ServerEventEnvelope,
} from "../../src/transport/wire";

const TEST_ATTRIBUTION = {
  languageDisplayName: "Synthetic",
  textDirection: "ltr" as const,
  checkModelDisplayName: "Fixture",
};

interface ApplyFixture {
  readonly family: "5" | "20" | "21";
  readonly sessionId: string;
  readonly source: string;
  readonly request: Omit<HostApplyRequest, "expectedRevision">;
  readonly expected: string;
  readonly activationRange: { readonly location: number; readonly length: number };
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
      expect(integrationScenarioDigest(fixture)).toBe(
        fixture.scenarioDigest,
      );
      let documentTransactions = 0;
      const view = createView(fixture.source, [
        history(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            documentTransactions += 1;
          }
        }),
      ]);
      const host = new CapturingObsidianHost(view, {
        sessionId: fixture.sessionId,
      });
      const applyRequests = vi.spyOn(host, "apply");
      const engine = new RecordingEngine();
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
            `${fixture.sessionId}:0`,
            `report-family-${fixture.family}`,
            fixture.activationRange,
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
        engine.emit({
          type: "applyRequested",
          actionId: perform.command.actionId,
          transactionId: `transaction-${fixture.family}`,
          request,
        });

        await vi.waitFor(() =>
          expect(engine.commandsOfType("completeApply")).toHaveLength(1),
        );
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

        engine.emit({
          type: "actionCompleted",
          actionId: perform.command.actionId,
        });
        await expect(action).resolves.toEqual({ status: "completed" });

        expect(undo(view)).toBe(true);
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

        await expect(host.apply(request)).resolves.toEqual({
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
    const engine = new RecordingEngine();
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
          "indeterminate:0",
          "indeterminate-suggestion",
          { location: 7, length: 2 },
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

  it("restores Apply after a non-atomic host refusal without mutating or redispatching", async () => {
    const source = "create an link";
    let documentTransactions = 0;
    const view = createView(source, [
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          documentTransactions += 1;
        }
      }),
    ]);
    const host = new NonAtomicObsidianHost(view, {
      sessionId: "non-atomic",
    });
    const apply = vi.spyOn(host, "apply");
    const engine = new RecordingEngine();
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
          "non-atomic:0",
          "non-atomic-suggestion",
          { location: 7, length: 2 },
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

class NonAtomicObsidianHost extends CapturingObsidianHost {
  override apply(_request: HostApplyRequest): Promise<HostApplyOutcome> {
    return Promise.resolve({ status: "unsupported", reason: "nonAtomic" });
  }
}

class RecordingEngine {
  readonly commands: { readonly command: ClientCommand; readonly id: string }[] = [];
  private readonly events = new AsyncQueue<ServerEventEnvelope>();
  private commandSequence = 0;
  private eventSequence = 0;

  connect(): Promise<RefineTransportSession> {
    return Promise.resolve({
      serverEpoch: "synthetic-epoch",
      runResumed: false,
      activatedCapabilities: [],
      send: async (command, commandId): Promise<CommandReceipt> => {
        this.commandSequence += 1;
        const id = commandId ?? `command-${this.commandSequence}`;
        this.commands.push({ command, id });
        return { sequence: this.commandSequence, id };
      },
      events: () => this.events,
      close: async () => this.events.close(),
    });
  }

  emit(
    event: ServerEventEnvelope["event"],
    causeCommandId?: string,
  ): void {
    this.eventSequence += 1;
    this.events.push({
      type: "event",
      sequence: this.eventSequence,
      epoch: "synthetic-epoch",
      ...(causeCommandId === undefined ? {} : { causeCommandId }),
      event,
    });
  }

  commandsOfType<T extends ClientCommand["type"]>(
    type: T,
  ): readonly {
    readonly command: Extract<ClientCommand, { readonly type: T }>;
    readonly id: string;
  }[] {
    return this.commands.filter(
      (
        command,
      ): command is {
        readonly command: Extract<ClientCommand, { readonly type: T }>;
        readonly id: string;
      } => command.command.type === type,
    );
  }

  async waitForCommand<T extends ClientCommand["type"]>(
    type: T,
  ): Promise<{
    readonly command: Extract<ClientCommand, { readonly type: T }>;
    readonly id: string;
  }> {
    await vi.waitFor(() => expect(this.commandsOfType(type)).toHaveLength(1));
    const command = this.commandsOfType(type)[0];
    if (!command) {
      throw new Error(`expected ${type} command`);
    }
    return command;
  }
}

function suggestionPresentation(
  revision: string,
  suggestionId: string,
  activationRange: { readonly location: number; readonly length: number },
): Extract<
  ServerEventEnvelope["event"],
  { readonly type: "presentationContentReplaced" }
> {
  return {
    type: "presentationContentReplaced",
    checkId: `check-${suggestionId}`,
    content: {
      documentRevision: revision,
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
          activationRange,
          highlightRanges: [activationRange],
          diff: [],
          availableActions: ["apply"],
        },
      ],
    },
  };
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

function integrationScenarioDigest(fixture: ApplyFixture): string {
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
    "documentMutationCount=1",
    "completionReceiptCount=1",
    "authoritativeChangedRevisionReadback=true",
    "nativeSelectionWriteCount=0",
    "nativePasteCount=0",
    "completionStatus=applied",
    "undoRestoresSource=true",
    "staleRevisionRejected=true",
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
