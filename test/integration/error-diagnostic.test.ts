import { describe, expect, it, vi } from "vitest";

import { integrationErrorDiagnostic, type IntegrationErrorDiagnostic } from "../../src/integration/error-diagnostic";
import { createRefineIntegration, EngineFaultError } from "../../src/integration/refine-integration";
import type { HostObservation, PresentationSnapshot, WritingHost } from "../../src/integration/types";
import { DEFAULT_PRESENTATION_APPEARANCE, DEFAULT_PRESENTATION_INTERACTION } from "../../src/integration/types";
import { AsyncQueue } from "../../src/shared/async-queue";
import { FrameDecoder, FrameProtocolError, MAX_FRAME_BYTES } from "../../src/transport/frame-codec";
import type { RefineTransportSession } from "../../src/transport/refine-transport";
import type { ClientCommand, ServerEventEnvelope } from "../../src/transport/wire";

describe("integration error diagnostics", () => {
  it("omits a non-UUID run identity at the diagnostic boundary", () => {
    const diagnostic = integrationErrorDiagnostic("PRIVATE_RUN_SENTINEL", "integration", new Error("secret"));
    expect(diagnostic).toEqual({ schema: 1, boundary: "integration", category: "error", code: "unclassified" });
  });

  it("preserves a fatal frame exception and correlates it to the connection run ID", async () => {
    const probe = start();
    await probe.engine.waitForCommand("openDocument");
    const frame = Buffer.alloc(4);
    frame.writeUInt32BE(MAX_FRAME_BYTES + 1);
    let failure: Error;
    try {
      new FrameDecoder().push(frame);
      throw new Error("expected frame rejection");
    } catch (error) {
      failure = error as Error;
    }
    probe.engine.eventQueue.fail(failure);
    expect(await probe.result).toBe(failure);
    expect(probe.diagnostics).toContainEqual({
      schema: 1, runID: probe.runID(), boundary: "connection",
      category: "frame", code: "declaredFrameSize",
    });
    expect(probe.runID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("retains the finite engine fault code after the session closes", async () => {
    const probe = start();
    await probe.engine.waitForCommand("openDocument");
    probe.engine.emit({ type: "fault", code: "resourceLimit", fatal: true });
    expect(await probe.result).toBeInstanceOf(EngineFaultError);
    expect(probe.diagnostics).toContainEqual({
      schema: 1, runID: probe.runID(), boundary: "integration",
      category: "engineFault", code: "resourceLimit",
    });
  });

  it("classifies a host presentation exception and its typed cause without changing it", async () => {
    const cause = new RangeError("PRIVATE_NOTE_TEXT_SENTINEL");
    const probe = start((snapshot) => {
      if (snapshot.state.type === "complete") throw cause;
    });
    await probe.engine.waitForCommand("openDocument");
    probe.engine.emit(suggestionPresentation("check-secret", "suggestion-secret"));
    expect(await probe.result).toMatchObject({ name: "FatalHostError", cause });
    expect(probe.diagnostics).toContainEqual({
      schema: 1, runID: probe.runID(), boundary: "host",
      category: "host", code: "hostPresent",
      cause: { category: "rangeError", code: "unclassified" },
    });
    expect(JSON.stringify(probe.diagnostics)).not.toContain("PRIVATE_NOTE_TEXT_SENTINEL");
  });

  it("never copies arbitrary messages, names, codes, payloads, stacks, or nested causes", async () => {
    const secret = "PRIVATE_SOURCE_TOKEN_PATH_SENTINEL";
    const cause = Object.assign(new Error(secret, { cause: { text: secret } }), {
      name: secret, code: secret, stack: secret,
    });
    const failure = new FrameProtocolError(secret, { cause }, [{ sourceId: secret, text: secret }]);
    const probe = start();
    await probe.engine.waitForCommand("openDocument");
    probe.engine.eventQueue.fail(failure);
    expect(await probe.result).toBe(failure);
    expect(probe.diagnostics).toContainEqual({
      schema: 1, runID: probe.runID(), boundary: "connection",
      category: "frame", code: "unclassified",
      cause: { category: "error", code: "unclassified" },
    });
    expect(JSON.stringify(probe.diagnostics)).not.toContain(secret);
  });

  it("reports finite semantic validation failures from incoming presentations", async () => {
    const probe = start();
    await probe.engine.waitForCommand("openDocument");
    probe.engine.emit(suggestionPresentation("check-secret", "suggestion-secret", {
      activationRange: { location: 1000, length: 1 },
    }));
    expect(await probe.result).toBeInstanceOf(Error);
    expect(probe.diagnostics).toContainEqual({
      schema: 1, runID: probe.runID(), boundary: "connection",
      category: "engine", code: "activationRange",
    });
  });

  it("does not diagnose ordinary cancellation", async () => {
    const probe = start();
    await probe.engine.waitForCommand("openDocument");
    probe.controller.abort();
    expect(await probe.result).toBeUndefined();
    expect(probe.diagnostics).toEqual([]);
  });

  it("does not let a diagnostic callback replace the original failure", async () => {
    const probe = start(undefined, () => { throw new Error("diagnostic sink failed"); });
    await probe.engine.waitForCommand("openDocument");
    const failure = new FrameProtocolError("Socket ended in the middle of a frame");
    probe.engine.eventQueue.fail(failure);
    expect(await probe.result).toBe(failure);
  });
});

function start(
  present: (snapshot: PresentationSnapshot) => void = () => undefined,
  diagnosticSink?: (diagnostic: IntegrationErrorDiagnostic) => void,
) {
  const engine = new DiagnosticEngine();
  const controller = new AbortController();
  const observations = new AsyncQueue<HostObservation>();
  const diagnostics: IntegrationErrorDiagnostic[] = [];
  const snapshot = {
    revision: "doc:0",
    sources: [{ sourceId: "document", text: "This are wrong.", sourceSyntax: "plainText" as const }],
  };
  observations.push({ type: "snapshot", snapshot });
  const host: WritingHost = {
    async *observe(signal) {
      const abort = () => observations.close();
      signal.addEventListener("abort", abort, { once: true });
      try { yield* observations; }
      finally { signal.removeEventListener("abort", abort); }
    },
    present,
    validateRevision: vi.fn(async () => ({ status: "current" as const })),
    apply: vi.fn(async () => ({ status: "rejected" as const, reason: "staleRevision" as const, snapshot })),
  };
  let runID: string | undefined;
  const integration = createRefineIntegration({
    enginePort: {
      connect: (_signal, options) => {
        runID = options?.runId;
        return engine.connect();
      },
    },
    onErrorDiagnostic: diagnosticSink ?? ((diagnostic) => diagnostics.push(diagnostic)),
  });
  const result = integration.run({ host, signal: controller.signal }).catch((error: unknown) => error);
  return { engine, controller, result, diagnostics, runID: () => runID };
}

class DiagnosticEngine {
  readonly eventQueue = new AsyncQueue<ServerEventEnvelope>();
  private readonly commands: ClientCommand[] = [];
  private sequence = 0;

  connect(): Promise<RefineTransportSession> {
    return Promise.resolve({
      serverEpoch: "epoch", runResumed: false, activatedCapabilities: [],
      send: async (command, commandId) => {
        this.commands.push(command);
        return { sequence: this.commands.length, id: commandId ?? "command" };
      },
      events: () => this.eventQueue,
      close: async () => this.eventQueue.close(),
    });
  }

  emit(event: ServerEventEnvelope["event"]): void {
    this.eventQueue.push({ type: "event", sequence: ++this.sequence, epoch: "epoch", event });
  }

  async waitForCommand(type: ClientCommand["type"]): Promise<void> {
    await vi.waitFor(() => expect(this.commands.some((command) => command.type === type)).toBe(true));
  }
}

function suggestionPresentation(
  checkId: string,
  id: string,
  { activationRange = { location: 5, length: 3 } } = {},
): ServerEventEnvelope["event"] {
  return {
    type: "presentationContentReplaced", checkId,
    content: {
      documentRevision: "doc:0", status: "complete", coverage: "full",
      appearance: DEFAULT_PRESENTATION_APPEARANCE, interaction: DEFAULT_PRESENTATION_INTERACTION,
      suggestions: [{
        id, sourceId: "document", kind: "grammar", activationRange,
        highlightRanges: [activationRange], diff: [], availableActions: ["apply"],
        attribution: { languageDisplayName: "English", textDirection: "ltr", checkModelDisplayName: "Test" },
      }],
    },
  };
}
