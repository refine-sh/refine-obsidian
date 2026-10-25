import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CHECK_DIAGNOSTICS_CAPABILITY, type CheckDiagnosticIssue } from "../../src/integration/check-diagnostics";
import { createRefineIntegration } from "../../src/integration/refine-integration";
import { DEFAULT_PRESENTATION_APPEARANCE, DEFAULT_PRESENTATION_INTERACTION, type DocumentSnapshot, type HostApplyOutcome, type HostObservation, type PresentationSnapshot, type SuggestionActions, type WritingHost } from "../../src/integration/types";
import { AsyncQueue } from "../../src/shared/async-queue";
import { RefineTransport } from "../../src/transport/refine-transport";
import { encodeFrame, FrameDecoder } from "../../src/transport/frame-codec";
import type { ClientCommand, ClientCommandEnvelope, HelloFrame, PresentationContent, ServerEventEnvelope } from "../../src/transport/wire";

interface Case {
  id: string;
  activated: boolean;
  sources: { sourceId: string; text: string }[];
  content: Record<string, unknown>;
  valid: boolean;
}
const { cases } = JSON.parse(readFileSync(new URL("../fixtures/check-diagnostics-v1.json", import.meta.url), "utf8")) as { cases: Case[] };

const staleIssue: CheckDiagnosticIssue = {
  sourceId: "document", range: { location: 15, length: 6 }, kind: "grammar", reason: "unusableOutput",
};
const staleDiagnosticCases: { name: string; issues: CheckDiagnosticIssue[]; valid: boolean }[] = [
  {
    name: "valid source order", valid: true,
    issues: [staleIssue, { ...staleIssue, sourceId: "another", range: { location: 0, length: 1 } }],
  },
  {
    name: "valid tuple order", valid: true,
    issues: [
      { ...staleIssue, range: { location: 14, length: 1 } },
      { ...staleIssue, range: { location: 15, length: 5 } },
      { ...staleIssue, kind: "fluency", reason: "cancelled" },
      { ...staleIssue, kind: "fluency", reason: "excessiveChange" },
      { ...staleIssue, kind: "fluency", reason: "protectedTextRestoreFailed" },
      { ...staleIssue, kind: "fluency" },
      { ...staleIssue, reason: "cancelled" },
      staleIssue,
    ],
  },
  { name: "duplicate", valid: false, issues: [staleIssue, staleIssue] },
  {
    name: "descending location", valid: false,
    issues: [staleIssue, { ...staleIssue, range: { location: 0, length: 1 } }],
  },
  {
    name: "descending length", valid: false,
    issues: [staleIssue, { ...staleIssue, range: { location: 15, length: 5 } }],
  },
  {
    name: "descending kind", valid: false,
    issues: [staleIssue, { ...staleIssue, kind: "fluency" }],
  },
  {
    name: "descending reason", valid: false,
    issues: [staleIssue, { ...staleIssue, reason: "cancelled" }],
  },
  {
    name: "source reentry", valid: false,
    issues: [
      staleIssue,
      { ...staleIssue, sourceId: "another", range: { location: 0, length: 1 } },
      { ...staleIssue, range: { location: 22, length: 1 } },
    ],
  },
  { name: "unknown source", valid: false, issues: [{ ...staleIssue, sourceId: "missing" }] },
  { name: "out-of-bounds range", valid: false, issues: [{ ...staleIssue, range: { location: 100, length: 1 } }] },
  { name: "split scalar", valid: false, issues: [{ ...staleIssue, range: { location: 1, length: 1 } }] },
  {
    name: "reversed source order", valid: false,
    issues: [{ ...staleIssue, sourceId: "another", range: { location: 0, length: 1 } }, staleIssue],
  },
];

describe("negotiated check diagnostics", () => {
  it.each([true, false])("retains historical evidence only when the coordinator resumes (%s)", async (runResumed) => {
    const probe = startDiagnosticSession(undefined, { runResumed });
    try {
      await probe.waitForCommand("openDocument");
      probe.present("old-check", { status: "checking" });
      await vi.waitFor(() => expect(probe.presentations.at(-1)?.state.type).toBe("checking"));
      probe.observations.push({ type: "snapshot", snapshot: {
        revision: "doc:1", sources: [{ sourceId: "replacement", text: "New.", sourceSyntax: "plainText" }],
      } });
      await probe.waitForCommand("replaceDocument");
      probe.disconnect();
      await probe.waitForCommand("openDocument", 2);

      probe.present("old-check", {
        status: "complete", coverage: "partial",
        checkDiagnostics: { issues: [staleIssue], omittedIssueCount: 0 },
      });
      if (runResumed) {
        probe.present("current-check", { documentRevision: "doc:1", status: "complete", coverage: "full" });
        await vi.waitFor(() => expect(probe.presentations.at(-1)?.state).toEqual({ type: "complete", coverage: "full" }));
        expect(probe.failure()).toBeUndefined();
      } else {
        await vi.waitFor(() => expect(probe.failure()).toBeInstanceOf(Error));
      }
      expect(probe.presentations.some((presentation) => presentation.checkDiagnostics !== undefined)).toBe(false);
    } finally {
      await probe.close();
    }
  });

  it("ignores unknown-revision extension data when diagnostics were not activated", async () => {
    const probe = startDiagnosticSession(undefined, { activated: false });
    try {
      await probe.waitForCommand("openDocument");
      probe.present("unknown-check", {
        documentRevision: "never-sent", status: "complete", coverage: "partial",
        checkDiagnostics: { issues: [staleIssue], omittedIssueCount: 0 },
      });
      probe.present("current-check", { status: "complete", coverage: "full" });
      await vi.waitFor(() => expect(probe.presentations.at(-1)?.state).toEqual({ type: "complete", coverage: "full" }));
      expect(probe.failure()).toBeUndefined();
    } finally {
      await probe.close();
    }
  });

  it("validates an intermediate Apply outcome revision sent before a newer queued snapshot", async () => {
    let finishApply: ((outcome: HostApplyOutcome) => void) | undefined;
    const apply = vi.fn(() => new Promise<HostApplyOutcome>((resolve) => { finishApply = resolve; }));
    const probe = startDiagnosticSession(undefined, { apply });
    try {
      await probe.waitForCommand("openDocument");
      probe.present("initial-check", { status: "complete", coverage: "full", suggestions: [{
        id: "suggestion", sourceId: "document", kind: "grammar",
        activationRange: { location: 0, length: 5 }, highlightRanges: [{ location: 0, length: 5 }],
        diff: [], availableActions: ["apply"],
        attribution: { languageDisplayName: "English", textDirection: "ltr", checkModelDisplayName: "Test" },
      }] });
      await vi.waitFor(() => expect(probe.presentations.at(-1)?.suggestions).toHaveLength(1));
      const action = probe.actions()!.apply("suggestion");
      const perform = await probe.waitForCommand("performAction");
      probe.emit({ type: "applyRequested", actionId: perform.command.actionId, transactionId: "transaction", request: {
        expectedRevision: "doc:0", sourceId: "document",
        edits: [{ range: { location: 0, length: 5 }, expectedText: "First", replacement: "Better" }],
      } });
      await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
      probe.observations.push({ type: "snapshot", snapshot: {
        revision: "doc:2", sources: [{ sourceId: "replacement", text: "New.", sourceSyntax: "plainText" }],
      } });
      await vi.waitFor(() => expect(probe.presentations.at(-1)?.documentRevision).toBe("doc:2"));
      finishApply!({ status: "applied", snapshot: {
        revision: "doc:1", sources: [{ sourceId: "document", text: "Better passage. Second passage.", sourceSyntax: "plainText" }],
      } });
      await probe.waitForCommand("completeApply");
      await probe.waitForCommand("replaceDocument");

      probe.present("intermediate-check", {
        documentRevision: "doc:1", status: "complete", coverage: "partial",
        checkDiagnostics: { issues: [{ ...staleIssue, range: { location: 16, length: 6 } }], omittedIssueCount: 0 },
      });
      probe.present("current-check", { documentRevision: "doc:2", status: "complete", coverage: "full" });
      probe.emit({ type: "actionCompleted", actionId: perform.command.actionId });
      await action;
      await vi.waitFor(() => expect(probe.presentations.at(-1)?.state).toEqual({ type: "complete", coverage: "full" }));
      expect(probe.failure()).toBeUndefined();
      expect(probe.presentations.some((presentation) => presentation.checkDiagnostics !== undefined)).toBe(false);
    } finally {
      await probe.close();
    }
  });

  it("rejects diagnostics for a revision never sent to the peer", async () => {
    const probe = startDiagnosticSession();
    try {
      await probe.waitForCommand("openDocument");
      probe.present("unknown-check", {
        documentRevision: "unknown-revision", status: "complete", coverage: "partial",
        checkDiagnostics: { issues: [staleIssue], omittedIssueCount: 0 },
      });
      await vi.waitFor(() => expect(probe.failure()).toBeInstanceOf(Error));
      expect(probe.presentations.some((presentation) => presentation.checkDiagnostics !== undefined)).toBe(false);
    } finally {
      await probe.close();
    }
  });

  it("rejects malformed diagnostics from a superseded check on the current revision", async () => {
    const probe = startDiagnosticSession();
    try {
      await probe.waitForCommand("openDocument");
      probe.present("old-check", { status: "pending" });
      await vi.waitFor(() => expect(probe.presentations.at(-1)?.state.type).toBe("pending"));
      probe.present("current-check", { status: "checking", progress: { completedUnitCount: 1, totalUnitCount: 2 } });
      await vi.waitFor(() => expect(probe.presentations.at(-1)?.state.type).toBe("checking"));

      const issue = { sourceId: "document", range: { location: 0, length: 1 }, kind: "grammar" as const, reason: "unusableOutput" as const };
      probe.present("old-check", {
        status: "complete", coverage: "partial",
        checkDiagnostics: { issues: [issue, issue], omittedIssueCount: 0 },
      });

      await vi.waitFor(() => expect(probe.failure()).toBeInstanceOf(Error));
      expect(probe.presentations.some((presentation) => presentation.checkDiagnostics !== undefined)).toBe(false);
    } finally {
      await probe.close();
    }
  });

  it("ignores valid diagnostics from a superseded check on the current revision", async () => {
    const probe = startDiagnosticSession();
    try {
      await probe.waitForCommand("openDocument");
      probe.present("old-check", { status: "pending" });
      probe.present("current-check", { status: "checking", progress: { completedUnitCount: 1, totalUnitCount: 2 } });
      await vi.waitFor(() => expect(probe.presentations.at(-1)?.state.type).toBe("checking"));

      probe.present("old-check", {
        status: "complete", coverage: "partial",
        checkDiagnostics: { issues: [{ sourceId: "document", range: { location: 0, length: 1 }, kind: "grammar", reason: "unusableOutput" }], omittedIssueCount: 0 },
      });
      probe.present("current-check", { status: "complete", coverage: "full" });

      await vi.waitFor(() => expect(probe.presentations.at(-1)?.state).toEqual({ type: "complete", coverage: "full" }));
      expect(probe.presentations.some((presentation) => presentation.checkDiagnostics !== undefined)).toBe(false);
      expect(probe.failure()).toBeUndefined();
    } finally {
      await probe.close();
    }
  });

  it.each(staleDiagnosticCases)("validates $name old-revision diagnostics without using newer source bounds", async ({ issues, valid }) => {
    const probe = startDiagnosticSession([
      { sourceId: "document", text: "😀First passage. Second passage.", sourceSyntax: "plainText" },
      { sourceId: "another", text: "Another source.", sourceSyntax: "plainText" },
    ]);
    try {
      await probe.waitForCommand("openDocument");
      probe.present("old-check", { status: "checking" });
      await vi.waitFor(() => expect(probe.presentations.at(-1)?.state.type).toBe("checking"));
      probe.observations.push({ type: "snapshot", snapshot: {
        revision: "doc:1", sources: [{ sourceId: "replacement", text: "New.", sourceSyntax: "plainText" }],
      } });
      await probe.waitForCommand("replaceDocument");

      probe.present("old-check", {
        status: "complete", coverage: "partial",
        checkDiagnostics: { issues, omittedIssueCount: 0 },
      });
      if (!valid) {
        await vi.waitFor(() => expect(probe.failure()).toBeInstanceOf(Error));
      } else {
        probe.present("current-check", { documentRevision: "doc:1", status: "complete", coverage: "full" });

        await vi.waitFor(() => expect(probe.presentations.at(-1)).toMatchObject({
          documentRevision: "doc:1", state: { type: "complete", coverage: "full" },
        }));
        expect(probe.failure()).toBeUndefined();
      }
      expect(probe.presentations.some((presentation) => presentation.checkDiagnostics !== undefined)).toBe(false);
    } finally {
      await probe.close();
    }
  });

  it.each(cases)("$id through transport and integration", async (test) => {
    const frames = new AsyncQueue<unknown>();
    const observations = new AsyncQueue<HostObservation>();
    const presentations: PresentationSnapshot[] = [];
    const controller = new AbortController();
    const snapshot = { revision: "doc:0", sources: test.sources.map((source) => ({ ...source, sourceSyntax: "plainText" as const })) };
    observations.push({ type: "snapshot", snapshot });
    let opened = false;
    const host: WritingHost = {
      async *observe(signal) {
        const abort = () => observations.close();
        signal.addEventListener("abort", abort, { once: true });
        try { yield* observations; } finally { signal.removeEventListener("abort", abort); }
      },
      present: (presentation) => { presentations.push(presentation); },
      validateRevision: async () => ({ status: "current" }),
      apply: async () => ({ status: "unavailable", snapshot }),
    };
    const transport = new RefineTransport({
      client: { id: "test", version: "1", host: "test" },
      capabilities: [CHECK_DIAGNOSTICS_CAPABILITY],
      endpointLocator: { locate: async () => ({ version: 1, socketPath: "/unused", launchToken: "A".repeat(64), serverEpoch: "epoch", protocolMajor: 1, protocolMinor: 0, pid: 1 }) },
      connector: { connect: async () => ({
        send: async (value) => {
          const frame = value as { type: string; capabilities?: string[]; command?: { type: string } };
          if (frame.type === "hello") {
            expect(frame.capabilities).toContain(CHECK_DIAGNOSTICS_CAPABILITY);
            frames.push({ type: "welcome", protocol: { major: 1, minor: 0 }, serverEpoch: "epoch", runResumed: false,
              limits: { maxFrameBytes: 8_388_608, maxSources: 2, maxSourceBytes: 1_048_576 },
              capabilities: test.activated ? [CHECK_DIAGNOSTICS_CAPABILITY] : [] });
          }
          if (frame.command?.type === "openDocument") opened = true;
        },
        receive: () => frames,
        close: async () => frames.close(),
      }) },
    });
    const result = createRefineIntegration({ enginePort: transport }).run({ host, signal: controller.signal }).catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(opened).toBe(true));
      const envelope = { type: "event", sequence: 1, epoch: "epoch", event: {
        type: "presentationContentReplaced", checkId: "check", content: {
          documentRevision: "doc:0", appearance: DEFAULT_PRESENTATION_APPEARANCE,
          interaction: DEFAULT_PRESENTATION_INTERACTION, suggestions: [], ...test.content,
        },
      } };
      // Keep lexical 1.0 evidence for the strict integer vector.
      const json = test.id === "fractional-omitted"
        ? JSON.stringify(envelope).replace('"omittedIssueCount":1', '"omittedIssueCount":1.0')
        : JSON.stringify(envelope);
      const body = Buffer.from(json);
      const frame = Buffer.alloc(4 + body.length);
      frame.writeUInt32BE(body.length); body.copy(frame, 4);
      try { for (const decoded of new FrameDecoder().push(frame)) frames.push(decoded); }
      catch (error) { frames.fail(error as Error); }
      if (test.valid) {
        await vi.waitFor(() => expect(presentations.at(-1)?.state.type).toBe("complete"));
        expect(presentations.at(-1)?.checkDiagnostics).toEqual(test.activated ? test.content.checkDiagnostics : undefined);
      } else {
        expect(await result).toBeInstanceOf(Error);
        expect(presentations.some((presentation) => presentation.state.type === "complete")).toBe(false);
      }
    } finally {
      controller.abort(); frames.close(); observations.close(); await result;
    }
  });
});

function startDiagnosticSession(sources: DocumentSnapshot["sources"] = [
  { sourceId: "document", text: "First passage. Second passage.", sourceSyntax: "plainText" },
], options: { activated?: boolean; runResumed?: boolean; apply?: WritingHost["apply"] } = {}) {
  let frames = new AsyncQueue<unknown>();
  const observations = new AsyncQueue<HostObservation>();
  const presentations: PresentationSnapshot[] = [];
  const commands: ClientCommandEnvelope[] = [];
  let latestActions: SuggestionActions | undefined;
  let connections = 0;
  let sequence = 0;
  const controller = new AbortController();
  const snapshot: DocumentSnapshot = {
    revision: "doc:0",
    sources,
  };
  observations.push({ type: "snapshot", snapshot });
  const host: WritingHost = {
    async *observe(signal) {
      const abort = () => observations.close();
      signal.addEventListener("abort", abort, { once: true });
      try { yield* observations; } finally { signal.removeEventListener("abort", abort); }
    },
    present: (presentation, actions) => { presentations.push(presentation); latestActions = actions; },
    validateRevision: async () => ({ status: "current" }),
    apply: options.apply ?? (async () => ({ status: "unavailable", snapshot })),
  };
  const transport = new RefineTransport({
    client: { id: "test", version: "1", host: "test" },
    capabilities: [CHECK_DIAGNOSTICS_CAPABILITY],
    endpointLocator: { locate: async () => ({ version: 1, socketPath: "/unused", launchToken: "A".repeat(64), serverEpoch: "epoch", protocolMajor: 1, protocolMinor: 0, pid: 1 }) },
    connector: { connect: async () => {
      if (connections++ > 0) frames = new AsyncQueue<unknown>();
      sequence = 0;
      const connectionFrames = frames;
      return {
        send: async (value) => {
          const frame = value as HelloFrame | ClientCommandEnvelope;
          if (frame.type === "hello") {
            connectionFrames.push({ type: "welcome", protocol: { major: 1, minor: 0 }, serverEpoch: "epoch",
              runResumed: connections > 1 && options.runResumed === true,
              limits: { maxFrameBytes: 8_388_608, maxSources: 2, maxSourceBytes: 1_048_576 },
              capabilities: options.activated === false ? [] : [CHECK_DIAGNOSTICS_CAPABILITY] });
          } else {
            commands.push(frame);
          }
        },
        receive: () => connectionFrames,
        close: async () => connectionFrames.close(),
      };
    } },
  });
  let failure: unknown;
  const result = createRefineIntegration({ enginePort: transport, reconnectDelayMs: 0 }).run({ host, signal: controller.signal })
    .catch((error: unknown) => { failure = error; });
  const emit = (event: ServerEventEnvelope["event"]): void => {
    const encoded = encodeFrame({ type: "event", sequence: ++sequence, epoch: "epoch", event });
    for (const decoded of new FrameDecoder().push(encoded)) frames.push(decoded);
  };
  return {
    presentations,
    observations,
    actions: () => latestActions,
    disconnect: () => frames.close(),
    emit,
    failure: () => failure,
    waitForCommand: async <T extends ClientCommand["type"]>(type: T, occurrence = 1) => {
      await vi.waitFor(() => expect(commands.filter(({ command }) => command.type === type).length).toBeGreaterThanOrEqual(occurrence));
      return commands.filter(({ command }) => command.type === type)[occurrence - 1] as ClientCommandEnvelope & { command: Extract<ClientCommand, { type: T }> };
    },
    present: (checkId: string, content: Partial<PresentationContent> & Pick<PresentationContent, "status">) => {
      emit({
        type: "presentationContentReplaced", checkId, content: {
          documentRevision: "doc:0", appearance: DEFAULT_PRESENTATION_APPEARANCE,
          interaction: DEFAULT_PRESENTATION_INTERACTION, suggestions: [], ...content,
        },
      });
    },
    close: async () => {
      controller.abort(); frames.close(); observations.close(); await result;
    },
  };
}
