import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PRESENTATION_INTERACTION } from "../../src/integration/types";
import { EngineConnectionError } from "../../src/transport/engine-connection-error";
import { FrameDecoder } from "../../src/transport/frame-codec";
import { AsyncQueue } from "../../src/shared/async-queue";
import {
  EndpointDescriptorError,
  EndpointProtocolVersionError,
  type EndpointLocator,
} from "../../src/transport/endpoint-locator";
import {
  RefineTransport,
  EndpointReplacedError,
  HandshakeRejectedError,
  IncompatibleProtocolError,
  TransportProtocolError,
  type FrameConnection,
  type FrameConnector,
} from "../../src/transport/refine-transport";
import {
  isSourceSyntax,
  SOURCE_SYNTAXES,
  type ClientCommand,
} from "../../src/transport/wire";

const VALID_LAUNCH_TOKEN = "A".repeat(64);

describe("Refine transport handshake", () => {
  it.each([
    ["id", "test client"],
    ["version", "v1\n"],
    ["host", "é"],
    ["id", "a".repeat(129)],
  ] as const)(
    "rejects an invalid client %s identifier before discovery",
    (field, value) => {
      const client = {
        id: "test-client",
        version: "0.1.0",
        host: "test-host",
        [field]: value,
      };

      expect(() => new RefineTransport({ client })).toThrow(
        `client.${field} must be a 1-to-128-byte visible ASCII identifier`,
      );
    },
  );

  it("rejects an invalid run identifier before endpoint discovery", async () => {
    const locate = vi.fn(endpointLocator().locate);
    const connector: FrameConnector = {
      connect: vi.fn(async () => {
        throw new Error("should not connect");
      }),
    };
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: { locate },
    });

    await expect(
      transport.connect(new AbortController().signal, { runId: "run id" }),
    ).rejects.toThrow(
      "hello.runId must be a 1-to-128-byte visible ASCII identifier",
    );
    expect(locate).not.toHaveBeenCalled();
  });

  it("uses the declared frontend identity and interceptable action keys", async () => {
    const frames = new AsyncQueue<unknown>();
    const sent: unknown[] = [];
    const connector = connectionConnector(frames, sent, () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: { maxFrameBytes: 8_388_608, maxSources: 2, maxSourceBytes: 1_048_576 },
        capabilities: [],
      });
    });
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      frontend: { id: "test-frontend" },
      hostCapabilities: { interceptableSuggestionActionKeys: [] },
      connector,
      endpointLocator: endpointLocator(),
    });

    const session = await transport.connect(new AbortController().signal, {
      runId: "run-1",
    });

    expect(sent[0]).toMatchObject({
      frontend: { id: "test-frontend" },
      hostCapabilities: { interceptableSuggestionActionKeys: [] },
    });
    await session.close();
  });

  it("validates the optional frontend and host capability declaration", () => {
    const client = { id: "test-client", version: "0.1.0", host: "test-host" };

    expect(() => new RefineTransport({
      client,
      frontend: { id: "test frontend" },
    })).toThrow("frontend.id must be a 1-to-128-byte visible ASCII identifier");
    expect(() => new RefineTransport({
      client,
      hostCapabilities: {
        interceptableSuggestionActionKeys: ["tab", "tab"],
      },
    })).toThrow("duplicate-free");
  });

  it("presents the per-launch token and sequences commands and events", async () => {
    const frames = new AsyncQueue<unknown>();
    const sent: unknown[] = [];
    const connector = connectionConnector(frames, sent, () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: { maxFrameBytes: 8_388_608, maxSources: 2, maxSourceBytes: 1_048_576 },
        capabilities: [],
      });
    });
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    });

    const controller = new AbortController();
    const session = await transport.connect(controller.signal, {
      runId: "run-1",
    });
    expect(sent[0]).toEqual({
      type: "hello",
      protocol: { major: 1, minor: 0 },
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      hostCapabilities: {
        interceptableSuggestionActionKeys: [
          "tab",
          "escape",
          "return",
          "space",
          "delete",
          "leftArrow",
          "rightArrow",
          "upArrow",
          "downArrow",
          "leftShift",
          "rightShift",
          "leftOption",
          "rightOption",
          "leftControl",
          "rightControl",
        ],
      },
      runId: "run-1",
      launchToken: VALID_LAUNCH_TOKEN,
      capabilities: [],
    });
    expect(session.runResumed).toBe(false);

    const command = await session.send({
      type: "openDocument",
      snapshot: {
        revision: "doc:0",
        sources: [
          {
            sourceId: "document",
            text: "create an link",
            sourceSyntax: "plainText",
          },
        ],
      },
    });
    expect(command.sequence).toBe(1);
    expect(command.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[1]).toEqual({
      type: "command",
      sequence: 1,
      id: command.id,
      command: {
        type: "openDocument",
        snapshot: {
          revision: "doc:0",
          sources: [
            {
              sourceId: "document",
              text: "create an link",
              sourceSyntax: "plainText",
            },
          ],
        },
      },
    });

    const attentionCommand = await session.send({
      type: "updateAttention",
      revision: "doc:0",
      attention: {
        sourceId: "document",
        caretOffset: 9,
        visibleRanges: [{ location: 0, length: 14 }],
      },
    }, "command-attention");
    expect(attentionCommand).toEqual({ sequence: 2, id: "command-attention" });
    expect(sent[2]).toEqual({
      type: "command",
      sequence: 2,
      id: "command-attention",
      command: {
        type: "updateAttention",
        revision: "doc:0",
        attention: {
          sourceId: "document",
          caretOffset: 9,
          visibleRanges: [{ location: 0, length: 14 }],
        },
      },
    });

    const events = session.events(controller.signal)[Symbol.asyncIterator]();
    frames.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      causeCommandId: command.id,
      event: { type: "documentAccepted", revision: "doc:0" },
    });
    await expect(events.next()).resolves.toEqual({
      done: false,
      value: {
        type: "event",
        sequence: 1,
        epoch: "epoch-1",
        causeCommandId: command.id,
        event: { type: "documentAccepted", revision: "doc:0" },
      },
    });

    frames.push({
      type: "event",
      sequence: 2,
      epoch: "epoch-1",
      event: {
        type: "presentationContentReplaced",
        checkId: "check-1",
        content: {
          documentRevision: "doc:0",
          status: "complete",
          coverage: "full",
          appearance: {
            highlight: {
              style: "dashedUnderline",
              grammarColor: "#FF2D55",
              fluencyColor: "#007AFF",
            },
            diff: {
              additionColor: "#34C759",
              deletionColor: "#FF3B30",
              showHiddenWhitespace: true,
            },
          },
          interaction: DEFAULT_PRESENTATION_INTERACTION,
          suggestions: [
            {
              id: "suggestion-1",
              sourceId: "document",
              kind: "grammar",
              attribution: {
                languageDisplayName: "English (American)",
                textDirection: "ltr",
                checkModelDisplayName: "On-Device (Gemma)",
              },
              activationRange: { location: 0, length: 14 },
              highlightRanges: [{ location: 7, length: 2 }],
              diff: [
                { kind: "delete", text: "an" },
                { kind: "insert", text: "a" },
              ],
              availableActions: ["apply"],
            },
          ],
        },
      },
    });
    await expect(events.next()).resolves.toMatchObject({
      value: {
        sequence: 2,
        event: {
          type: "presentationContentReplaced",
          content: {
            appearance: {
              highlight: { style: "dashedUnderline" },
              diff: { showHiddenWhitespace: true },
            },
            interaction: DEFAULT_PRESENTATION_INTERACTION,
            suggestions: [{
              id: "suggestion-1",
              activationRange: { location: 0, length: 14 },
            }],
          },
        },
      },
    });

    frames.push({
      type: "event",
      sequence: 3,
      epoch: "epoch-1",
      event: {
        type: "explanationReplaced",
        actionId: "explain-1",
        update: {
          status: "started",
          attribution: {
            languageDisplayName: "English (American)",
            textDirection: "ltr",
            modelDisplayName: "OpenRouter (GPT-5.6)",
          },
        },
      },
    });
    await expect(events.next()).resolves.toMatchObject({
      value: {
        sequence: 3,
        event: {
          type: "explanationReplaced",
          update: {
            status: "started",
            attribution: { modelDisplayName: "OpenRouter (GPT-5.6)" },
          },
        },
      },
    });

    frames.push({
      type: "event",
      sequence: 5,
      epoch: "epoch-1",
      event: { type: "documentAccepted", revision: "doc:0" },
    });
    await expect(events.next()).rejects.toThrow(TransportProtocolError);

    controller.abort();
    await session.close();
  });

  it("decodes optional determinate progress on checking presentations", async () => {
    const fixture = await connectedEventFixture();
    fixture.frames.push(checkingProgressEvent(
      { completedUnitCount: 2, totalUnitCount: 5 },
    ));

    await expect(fixture.events.next()).resolves.toMatchObject({
      value: {
        event: {
          type: "presentationContentReplaced",
          content: {
            status: "checking",
            progress: { completedUnitCount: 2, totalUnitCount: 5 },
          },
        },
      },
    });

    fixture.frames.push(checkingProgressEvent(undefined, "checking", 2));
    await expect(fixture.events.next()).resolves.not.toHaveProperty(
      "value.event.content.progress",
    );

    await fixture.session.close();
  });

  it("rejects suggestions while presentation status is pending", async () => {
    const fixture = await connectedEventFixture();
    const message = checkingProgressEvent(undefined, "pending") as {
      event: { content: { suggestions: unknown[] } };
    };
    message.event.content.suggestions.push({
      id: "suggestion-1",
      sourceId: "document",
      kind: "grammar",
      attribution: {
        languageDisplayName: "English",
        textDirection: "ltr",
        checkModelDisplayName: "Refine",
      },
      activationRange: { location: 0, length: 1 },
      highlightRanges: [{ location: 0, length: 1 }],
      diff: [{ kind: "delete", text: "a" }],
      availableActions: ["dismiss"],
    });
    fixture.frames.push(message);

    await expect(fixture.events.next()).rejects.toThrow(TransportProtocolError);
    await fixture.session.close();
  });

  it.each(["unavailable", "closed"] as const)(
    "rejects suggestions while presentation status is %s",
    async (status) => {
      const fixture = await connectedEventFixture();
      const message = checkingProgressEvent(undefined, status) as {
        event: { content: { suggestions: unknown[] } };
      };
      const complete = completePresentationEvent(
        DEFAULT_PRESENTATION_INTERACTION,
      ) as { event: { content: { suggestions: unknown[] } } };
      message.event.content.suggestions.push(
        complete.event.content.suggestions[0],
      );
      fixture.frames.push(message);

      await expect(fixture.events.next()).rejects.toThrow(
        TransportProtocolError,
      );
      await fixture.session.close();
    },
  );

  it("rejects duplicate suggestion available actions", async () => {
    const fixture = await connectedEventFixture();
    const message = completePresentationEvent(
      DEFAULT_PRESENTATION_INTERACTION,
    ) as {
      event: {
        content: {
          suggestions: Array<{ availableActions: string[] }>;
        };
      };
    };
    message.event.content.suggestions[0]!.availableActions = [
      "apply",
      "apply",
    ];
    fixture.frames.push(message);

    await expect(fixture.events.next()).rejects.toThrow(
      TransportProtocolError,
    );
    await fixture.session.close();
  });

  it.each([
    ["pending", { coverage: "full" }],
    ["pending", { unavailableReason: "checkFailed" }],
    ["checking", { coverage: "full" }],
    ["checking", { unavailableReason: "checkFailed" }],
    ["complete", { unavailableReason: "checkFailed" }],
    ["unavailable", { coverage: "full" }],
    ["closed", { coverage: "full" }],
    ["closed", { unavailableReason: "checkFailed" }],
  ] as const)(
    "rejects members forbidden for presentation status %s",
    async (status, extra) => {
      const fixture = await connectedEventFixture();
      const message = checkingProgressEvent(undefined, status) as {
        event: { content: Record<string, unknown> };
      };
      Object.assign(message.event.content, extra);
      fixture.frames.push(message);

      await expect(fixture.events.next()).rejects.toThrow(
        TransportProtocolError,
      );
      await fixture.session.close();
    },
  );

  it.each([
    ["a negative count", "checking", { completedUnitCount: -1, totalUnitCount: 5 }],
    ["a negative total", "checking", { completedUnitCount: 0, totalUnitCount: -1 }],
    ["a fractional count", "checking", { completedUnitCount: 1.5, totalUnitCount: 5 }],
    ["completed above total", "checking", { completedUnitCount: 6, totalUnitCount: 5 }],
    ["progress while pending", "pending", { completedUnitCount: 1, totalUnitCount: 1 }],
    ["progress while complete", "complete", { completedUnitCount: 1, totalUnitCount: 1 }],
    ["progress while unavailable", "unavailable", { completedUnitCount: 1, totalUnitCount: 1 }],
    ["progress while closed", "closed", { completedUnitCount: 1, totalUnitCount: 1 }],
  ] as const)("rejects presentation progress with %s", async (_case, status, progress) => {
    const fixture = await connectedEventFixture();
    fixture.frames.push(checkingProgressEvent(progress, status));

    await expect(fixture.events.next()).rejects.toThrow(TransportProtocolError);
    await fixture.session.close();
  });

  it("rejects a welcome from a replaced server epoch", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
        serverEpoch: "epoch-2",
        runResumed: false,
        limits: { maxFrameBytes: 8_388_608, maxSources: 2, maxSourceBytes: 1_048_576 },
        capabilities: [],
      });
    });
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    });

    const connection = transport.connect(new AbortController().signal);
    await expect(connection).rejects.toThrow(EndpointReplacedError);
    await expect(connection).rejects.toMatchObject({ recoverability: "recoverable" });
  });

  it("requires the fixed decoded source-byte limit in welcome", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: { maxFrameBytes: 8_388_608, maxSources: 2 },
        capabilities: [],
      });
    });
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    });

    await expect(
      transport.connect(new AbortController().signal),
    ).rejects.toThrow(TransportProtocolError);
  });

  it("offers a recognized capability and accepts the server ignoring it", async () => {
    const frames = new AsyncQueue<unknown>();
    const sent: unknown[] = [];
    const connector = connectionConnector(frames, sent, () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: {
          maxFrameBytes: 8_388_608,
          maxSources: 2,
          maxSourceBytes: 1_048_576,
        },
        capabilities: [],
      });
    });
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      capabilities: ["com.example.refine.test.v1"],
      connector,
      endpointLocator: endpointLocator(),
    });

    const session = await transport.connect(new AbortController().signal);

    expect(sent[0]).toMatchObject({
      capabilities: ["com.example.refine.test.v1"],
    });
    expect(session.activatedCapabilities).toEqual([]);
    await session.close();
  });

  it("rejects duplicate capability offers before opening a connection", () => {
    expect(() => new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      capabilities: [
        "com.example.refine.test.v1",
        "com.example.refine.test.v1",
      ],
    })).toThrow("Capability offers must be duplicate-free");
  });

  it("rejects more than 64 capability offers", () => {
    expect(() => new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      capabilities: Array.from(
        { length: 65 },
        (_value, index) => `com.example.refine.test-${index}.v1`,
      ),
    })).toThrow("Capability offers cannot contain more than 64 entries");
  });

  it.each([
    "",
    "com.example.refine test.v1",
    "com.example.refine.tést.v1",
    "x".repeat(129),
  ])("rejects an invalid capability offer %j", (capability) => {
    expect(() => new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      capabilities: [capability],
    })).toThrow("Capability identifiers must contain 1 to 128 visible ASCII bytes");
  });

  it("rejects a capability activation the client did not offer", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: {
          maxFrameBytes: 8_388_608,
          maxSources: 2,
          maxSourceBytes: 1_048_576,
        },
        capabilities: ["com.example.refine.unoffered.v1"],
      });
    });
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    });

    await expect(
      transport.connect(new AbortController().signal),
    ).rejects.toThrow("Server activated an unsupported capability");
  });

  it("rejects duplicate capability activations", async () => {
    const capability = "com.example.refine.test.v1";
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: {
          maxFrameBytes: 8_388_608,
          maxSources: 2,
          maxSourceBytes: 1_048_576,
        },
        capabilities: [capability, capability],
      });
    });
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      capabilities: [capability],
      connector,
      endpointLocator: endpointLocator(),
    });

    await expect(
      transport.connect(new AbortController().signal),
    ).rejects.toThrow("Capability activations must be duplicate-free");
  });

  it("rejects more than 64 capability activations", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: {
          maxFrameBytes: 8_388_608,
          maxSources: 2,
          maxSourceBytes: 1_048_576,
        },
        capabilities: Array.from(
          { length: 65 },
          (_value, index) => `com.example.refine.test-${index}.v1`,
        ),
      });
    });
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    });

    await expect(
      transport.connect(new AbortController().signal),
    ).rejects.toThrow("Capability activations cannot contain more than 64 entries");
  });

  it("rejects an invalid capability activation identifier", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: {
          maxFrameBytes: 8_388_608,
          maxSources: 2,
          maxSourceBytes: 1_048_576,
        },
        capabilities: ["com.example.refine test.v1"],
      });
    });
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    });

    await expect(
      transport.connect(new AbortController().signal),
    ).rejects.toThrow("Malformed capability activation identifier");
  });

  it("exposes the activated subset of the offered capabilities", async () => {
    const capability = "com.example.refine.test.v1";
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: {
          maxFrameBytes: 8_388_608,
          maxSources: 2,
          maxSourceBytes: 1_048_576,
        },
        capabilities: [capability],
      });
    });
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      capabilities: [capability, "com.example.refine.ignored.v1"],
      connector,
      endpointLocator: endpointLocator(),
    });

    const session = await transport.connect(new AbortController().signal);

    expect(session.activatedCapabilities).toEqual([capability]);
    await session.close();
  });

  it.each([
    { major: 0, minor: 9 },
    { major: 2, minor: 0 },
  ] as const)(
    "reports both exact versions for incompatible welcome protocol %s",
    async (protocol) => {
      const frames = new AsyncQueue<unknown>();
      const connector = connectionConnector(frames, [], () => {
        frames.push({
          type: "welcome",
          protocol,
          serverEpoch: "epoch-1",
          runResumed: false,
          limits: { maxFrameBytes: 8_388_608, maxSources: 2, maxSourceBytes: 1_048_576 },
          capabilities: [],
        });
      });
      const transport = new RefineTransport({
        client: { id: "test-client", version: "0.1.0", host: "test-host" },
        connector,
        endpointLocator: endpointLocator(),
      });

      const connection = transport.connect(new AbortController().signal);
      await expect(connection).rejects.toThrow(IncompatibleProtocolError);
      await expect(connection).rejects.toMatchObject({
        recoverability: "fatal",
        clientProtocol: { major: 1, minor: 0 },
        serverProtocol: protocol,
      });
      await expect(connection).rejects.not.toHaveProperty("requiredUpdate");
    },
  );

  it("decodes an invalid-client rejection as a fatal no-recovery outcome", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "rejected",
        reason: "invalidClient",
        recovery: "none",
        protocol: { major: 1, minor: 0 },
      });
    });
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    });

    const error = await transport
      .connect(new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HandshakeRejectedError);
    expect(error).not.toBeInstanceOf(IncompatibleProtocolError);
    expect(error).toMatchObject({
      reason: "invalidClient",
      recovery: "none",
      protocol: { major: 1, minor: 0 },
      recoverability: "fatal",
    });
    expect(error).not.toHaveProperty("receivedProtocol");
  });

  it.each([
    ["runUnavailable", "newRun"],
    ["runUnavailable", "retry"],
    ["serverBusy", "retry"],
    ["engineUnavailable", "retry"],
  ] as const)(
    "decodes %s/%s as a recoverable rejection",
    async (reason, recovery) => {
      const frames = new AsyncQueue<unknown>();
      const connector = connectionConnector(frames, [], () => {
        frames.push({
          type: "rejected",
          reason,
          recovery,
          protocol: { major: 1, minor: 0 },
        });
      });
      const transport = new RefineTransport({
        client: { id: "test-client", version: "0.1.0", host: "test-host" },
        connector,
        endpointLocator: endpointLocator(),
      });

      const error = await transport
        .connect(new AbortController().signal)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HandshakeRejectedError);
      expect(error).toMatchObject({
        reason,
        recovery,
        protocol: { major: 1, minor: 0 },
        recoverability: "recoverable",
      });
      expect(error).not.toHaveProperty("receivedProtocol");
    },
  );

  it("rejects out-of-range protocol components in a welcome", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "welcome",
        protocol: { major: 0x1_0000, minor: 0 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: { maxFrameBytes: 8_388_608, maxSources: 2, maxSourceBytes: 1_048_576 },
        capabilities: [],
      });
    });
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    });

    const error = await transport
      .connect(new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TransportProtocolError);
    expect(error).not.toBeInstanceOf(IncompatibleProtocolError);
    expect(error).toMatchObject({ message: "Malformed welcome protocol version" });
  });

  it("rejects exponent spelling for an integer welcome field", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push(decodeRawFrame(`{
        "type": "welcome",
        "protocol": { "major": 1e0, "minor": 0 },
        "serverEpoch": "epoch-1",
        "runResumed": false,
        "limits": {
          "maxFrameBytes": 8388608,
          "maxSources": 2,
          "maxSourceBytes": 1048576
        },
        "capabilities": []
      }`));
    });
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    });

    await expect(
      transport.connect(new AbortController().signal),
    ).rejects.toThrow("Frame body is not valid JSON");
  });

  it.each([
    { major: 0, minor: 9 },
    { major: 2, minor: 0 },
  ] as const)(
    "reports both exact versions for a rejected protocol %s",
    async (receivedProtocol) => {
      const frames = new AsyncQueue<unknown>();
      const connector = connectionConnector(frames, [], () => {
        frames.push({
          type: "rejected",
          reason: "incompatibleProtocol",
          recovery: "none",
          protocol: { major: 1, minor: 0 },
          receivedProtocol,
        });
      });
      const transport = new RefineTransport({
        client: { id: "test-client", version: "0.1.0", host: "test-host" },
        connector,
        endpointLocator: endpointLocator(),
      });

      await expect(
        transport.connect(new AbortController().signal),
      ).rejects.toMatchObject({
        recoverability: "fatal",
        reason: "incompatibleProtocol",
        recovery: "none",
        clientProtocol: receivedProtocol,
        serverProtocol: { major: 1, minor: 0 },
      });
    },
  );

  it("rejects out-of-range protocol components in a handshake rejection", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "rejected",
        reason: "incompatibleProtocol",
        recovery: "none",
        protocol: { major: 0x1_0000, minor: 0 },
        receivedProtocol: { major: 1, minor: 0 },
      });
    });
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    });

    const error = await transport
      .connect(new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TransportProtocolError);
    expect(error).not.toBeInstanceOf(IncompatibleProtocolError);
    expect(error).toMatchObject({ message: "Malformed handshake rejection" });
  });

  it.each([
    ["incompatibleProtocol", "retry"],
    ["invalidClient", "retry"],
    ["runUnavailable", "none"],
    ["serverBusy", "none"],
    ["engineUnavailable", "newRun"],
  ] as const)(
    "rejects the undefined handshake recovery pair %s/%s",
    async (reason, recovery) => {
      const frames = new AsyncQueue<unknown>();
      const connector = connectionConnector(frames, [], () => {
        frames.push({
          type: "rejected",
          reason,
          recovery,
          protocol: { major: 1, minor: 0 },
          ...(reason === "incompatibleProtocol"
            ? { receivedProtocol: { major: 1, minor: 0 } }
            : {}),
        });
      });
      const transport = new RefineTransport({
        client: { id: "test-client", version: "0.1.0", host: "test-host" },
        connector,
        endpointLocator: endpointLocator(),
      });

      await expect(
        transport.connect(new AbortController().signal),
      ).rejects.toMatchObject({
        name: "TransportProtocolError",
        message: "Malformed handshake rejection",
      });
    },
  );

  it("rejects receivedProtocol on a non-version rejection", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "rejected",
        reason: "invalidClient",
        recovery: "none",
        protocol: { major: 1, minor: 0 },
        receivedProtocol: { major: 1, minor: 0 },
      });
    });
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    });

    await expect(
      transport.connect(new AbortController().signal),
    ).rejects.toMatchObject({
      name: "TransportProtocolError",
      message: "Malformed handshake rejection",
    });
  });

  it("treats a clean pre-welcome close as a recoverable connection failure", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => frames.close());
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: {
        locate: async () => ({
          version: 1,
          socketPath: "/private/tmp/refine-1/integration.sock",
          launchToken: VALID_LAUNCH_TOKEN,
          serverEpoch: "epoch-1",
          protocolMajor: 1,
          protocolMinor: 0,
          pid: 123,
        }),
      },
    });

    const error = await transport
      .connect(new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EngineConnectionError);
    expect(error).not.toBeInstanceOf(IncompatibleProtocolError);
    expect(error).toMatchObject({
      message: "Refine closed the connection before welcome",
      recoverability: "recoverable",
    });
  });

  it.each([
    ["hello send", true],
    ["first response frame", false],
  ] as const)(
    "times out a stalled %s after five seconds and closes exactly once",
    async (_stage, stallSend) => {
      vi.useFakeTimers();
      const frames = new AsyncQueue<unknown>();
      let releaseSend: (() => void) | undefined;
      const stalledSend = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      let markSendSettled: (() => void) | undefined;
      const sendSettled = new Promise<void>((resolve) => {
        markSendSettled = resolve;
      });
      const close = vi.fn(async () => {
        releaseSend?.();
        frames.close();
      });
      const send = vi.fn(async (): Promise<void> => {
        if (stallSend) {
          await stalledSend;
        }
        markSendSettled?.();
      });
      const connector: FrameConnector = {
        connect: async () => ({
          send,
          receive: () => frames,
          close,
        }),
      };
      const transport = new RefineTransport({
        client: { id: "test-client", version: "0.1.0", host: "test-host" },
        connector,
        endpointLocator: endpointLocator(),
      });
      const connecting = transport.connect(new AbortController().signal);
      const failure = connecting.catch((error: unknown) => error);

      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(send).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(4_999);
        expect(close).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(close).toHaveBeenCalledOnce();
        await expect(failure).resolves.toMatchObject({
          message: "Timed out waiting for Refine welcome",
          recoverability: "recoverable",
        });

        await vi.advanceTimersByTimeAsync(5_000);
        expect(close).toHaveBeenCalledOnce();
      } finally {
        releaseSend?.();
        frames.close();
        await sendSettled;
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
      }
    },
  );

  it("preserves the abort reason when clean EOF races cancellation", async () => {
    const frames = new AsyncQueue<unknown>();
    const close = vi.fn(async () => frames.close());
    let markHelloSent: (() => void) | undefined;
    const helloSent = new Promise<void>((resolve) => {
      markHelloSent = resolve;
    });
    const connector: FrameConnector = {
      connect: async () => ({
        send: async () => markHelloSent?.(),
        receive: () => frames,
        close,
      }),
    };
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    });
    const controller = new AbortController();
    const reason = new DOMException("Run stopped", "AbortError");
    const connecting = transport.connect(controller.signal);
    const failure = connecting.catch((error: unknown) => error);
    await helloSent;

    frames.close();
    controller.abort(reason);

    await expect(failure).resolves.toBe(reason);
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves the abort reason when a welcome races cancellation", async () => {
    const frames = new AsyncQueue<unknown>();
    const close = vi.fn(async () => frames.close());
    let markHelloSent: (() => void) | undefined;
    const helloSent = new Promise<void>((resolve) => {
      markHelloSent = resolve;
    });
    const connector: FrameConnector = {
      connect: async () => ({
        send: async () => markHelloSent?.(),
        receive: () => frames,
        close,
      }),
    };
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    });
    const controller = new AbortController();
    const reason = new DOMException("Run stopped", "AbortError");
    const connecting = transport.connect(controller.signal);
    const failure = connecting.catch((error: unknown) => error);
    await helloSent;

    frames.push({
      type: "welcome",
      protocol: { major: 1, minor: 0 },
      serverEpoch: "epoch-1",
      runResumed: false,
      limits: { maxFrameBytes: 8_388_608, maxSources: 2, maxSourceBytes: 1_048_576 },
      capabilities: [],
    });
    queueMicrotask(() => controller.abort(reason));

    await expect(failure).resolves.toBe(reason);
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves the abort reason when cancellation races the welcome deadline", async () => {
    vi.useFakeTimers();
    const frames = new AsyncQueue<unknown>();
    const close = vi.fn(async () => frames.close());
    const connector: FrameConnector = {
      connect: async () => ({
        send: async () => undefined,
        receive: () => frames,
        close,
      }),
    };
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    });
    const controller = new AbortController();
    const reason = new DOMException("Run stopped", "AbortError");
    setTimeout(() => controller.abort(reason), 5_000);
    const connecting = transport.connect(controller.signal);
    const failure = connecting.catch((error: unknown) => error);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(failure).resolves.toBe(reason);
      expect(close).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      frames.close();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it("accepts a compatible welcome from an exact descriptor", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: { maxFrameBytes: 8_388_608, maxSources: 2, maxSourceBytes: 1_048_576 },
        capabilities: [],
      });
    });
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: {
        locate: async () => ({
          version: 1,
          socketPath: "/private/tmp/refine-1/integration.sock",
          launchToken: VALID_LAUNCH_TOKEN,
          serverEpoch: "epoch-1",
          protocolMajor: 1,
          protocolMinor: 0,
          pid: 123,
        }),
      },
    });

    const session = await transport.connect(new AbortController().signal);

    expect(session.serverEpoch).toBe("epoch-1");
    await session.close();
  });

  it.each([
    { major: 0, minor: 9 },
    { major: 2, minor: 0 },
  ] as const)(
    "reports both exact versions from endpoint protocol %s",
    async (receivedProtocol) => {
      const connector: FrameConnector = {
        connect: vi.fn(async () => {
          throw new Error("should not connect");
        }),
      };
      const transport = new RefineTransport({
        client: { id: "test-client", version: "0.1.0", host: "test-host" },
        connector,
        endpointLocator: {
          locate: async () => {
            throw new EndpointProtocolVersionError(receivedProtocol);
          },
        },
      });

      await expect(
        transport.connect(new AbortController().signal),
      ).rejects.toMatchObject({
        recoverability: "fatal",
        clientProtocol: { major: 1, minor: 0 },
        serverProtocol: receivedProtocol,
      });
      expect(connector.connect).not.toHaveBeenCalled();
    },
  );

  it("ignores an unknown presentation appearance member", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: { maxFrameBytes: 8_388_608, maxSources: 2, maxSourceBytes: 1_048_576 },
        capabilities: [],
      });
    });
    const session = await new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    }).connect(new AbortController().signal);
    const events = session.events(new AbortController().signal)[Symbol.asyncIterator]();
    frames.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      event: {
        type: "presentationContentReplaced",
        checkId: "check-1",
        content: {
          documentRevision: "doc:0",
          status: "complete",
          coverage: "full",
          appearance: {
            highlight: {
              style: "underline",
              grammarColor: "#FF2D55",
              fluencyColor: "#007AFF",
              unexpected: true,
            },
            diff: {
              additionColor: "#34C759",
              deletionColor: "#FF3B30",
              showHiddenWhitespace: true,
            },
          },
          interaction: DEFAULT_PRESENTATION_INTERACTION,
          suggestions: [],
        },
      },
    });

    await expect(events.next()).resolves.toMatchObject({
      value: {
        event: {
          type: "presentationContentReplaced",
          content: {
            appearance: {
              highlight: { style: "underline" },
            },
          },
        },
      },
    });
    await session.close();
  });

  it("decodes synchronized automatic-check and Quick Apply interaction settings", async () => {
    const fixture = await connectedEventFixture();
    const interaction = {
      automaticChecksEnabled: false,
      quickApply: {
        enabled: false,
        applyKey: "rightShift",
        dismissKey: "leftControl",
        activationStyle: "highlightChanges",
      },
    };
    fixture.frames.push(completePresentationEvent(interaction));

    await expect(fixture.events.next()).resolves.toMatchObject({
      value: {
        event: {
          type: "presentationContentReplaced",
          content: {
            interaction,
            suggestions: [{ activationRange: { location: 0, length: 14 } }],
          },
        },
      },
    });
    await fixture.session.close();
  });

  it("leaves conflicting Quick Apply keys to the Refine settings UI", async () => {
    const fixture = await connectedEventFixture();
    const interaction = {
      automaticChecksEnabled: true,
      quickApply: {
        ...DEFAULT_PRESENTATION_INTERACTION.quickApply,
        dismissKey: "tab",
      },
    };
    fixture.frames.push(completePresentationEvent(interaction));

    await expect(fixture.events.next()).resolves.toMatchObject({
      value: {
        event: {
          type: "presentationContentReplaced",
          content: { interaction },
        },
      },
    });
    await fixture.session.close();
  });

  it.each([
    [
      "a missing automaticChecksEnabled value",
      { quickApply: DEFAULT_PRESENTATION_INTERACTION.quickApply },
    ],
    ["a missing quickApply object", { automaticChecksEnabled: true }],
    [
      "a non-boolean automaticChecksEnabled value",
      { ...DEFAULT_PRESENTATION_INTERACTION, automaticChecksEnabled: "true" },
    ],
    [
      "an unknown apply key",
      {
        automaticChecksEnabled: true,
        quickApply: {
          ...DEFAULT_PRESENTATION_INTERACTION.quickApply,
          applyKey: "command",
        },
      },
    ],
    [
      "an unknown dismiss key",
      {
        automaticChecksEnabled: true,
        quickApply: {
          ...DEFAULT_PRESENTATION_INTERACTION.quickApply,
          dismissKey: "command",
        },
      },
    ],
    [
      "an unknown activation style",
      {
        automaticChecksEnabled: true,
        quickApply: {
          ...DEFAULT_PRESENTATION_INTERACTION.quickApply,
          activationStyle: "showTip",
        },
      },
    ],
  ] as const)("fails closed when presentation interaction contains %s", async (_case, interaction) => {
    const fixture = await connectedEventFixture();
    fixture.frames.push(completePresentationEvent(interaction));

    await expect(fixture.events.next()).rejects.toThrow(TransportProtocolError);
    await fixture.session.close();
  });

  it.each([
    {
      ...DEFAULT_PRESENTATION_INTERACTION,
      unexpected: true,
    },
    {
      automaticChecksEnabled: true,
      quickApply: {
        ...DEFAULT_PRESENTATION_INTERACTION.quickApply,
        unexpected: true,
      },
    },
  ])("ignores unknown presentation interaction members", async (interaction) => {
    const fixture = await connectedEventFixture();
    fixture.frames.push(completePresentationEvent(interaction));

    await expect(fixture.events.next()).resolves.toMatchObject({
      value: {
        event: {
          type: "presentationContentReplaced",
          content: { interaction: DEFAULT_PRESENTATION_INTERACTION },
        },
      },
    });
    await fixture.session.close();
  });

  it("ignores an unknown suggestion activation-range member", async () => {
    const fixture = await connectedEventFixture();
    fixture.frames.push(completePresentationEvent(
      DEFAULT_PRESENTATION_INTERACTION,
      { location: 0, length: 14, unexpected: true },
    ));

    await expect(fixture.events.next()).resolves.toMatchObject({
      value: {
        event: {
          type: "presentationContentReplaced",
          content: {
            suggestions: [{ activationRange: { location: 0, length: 14 } }],
          },
        },
      },
    });
    await fixture.session.close();
  });

  it("decodes Protocol 1.0 unavailable reasons and rejects unknown ones", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: { maxFrameBytes: 8_388_608, maxSources: 2, maxSourceBytes: 1_048_576 },
        capabilities: [],
      });
    });
    const session = await new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    }).connect(new AbortController().signal);
    const events = session.events(new AbortController().signal)[Symbol.asyncIterator]();
    frames.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      event: {
        type: "presentationContentReplaced",
        checkId: "check-1",
        content: {
          documentRevision: "doc:0",
          status: "unavailable",
          unavailableReason: "checkFailed",
          appearance: {
            highlight: {
              style: "underline",
              grammarColor: "#FF2D55",
              fluencyColor: "#007AFF",
            },
            diff: {
              additionColor: "#34C759",
              deletionColor: "#FF3B30",
              showHiddenWhitespace: true,
            },
          },
          interaction: DEFAULT_PRESENTATION_INTERACTION,
          suggestions: [],
        },
      },
    });

    await expect(events.next()).resolves.toMatchObject({
      value: {
        event: {
          type: "presentationContentReplaced",
          content: {
            status: "unavailable",
            unavailableReason: "checkFailed",
          },
        },
      },
    });

    frames.push({
      type: "event",
      sequence: 2,
      epoch: "epoch-1",
      event: {
        type: "presentationContentReplaced",
        checkId: "check-2",
        content: {
          documentRevision: "doc:0",
          status: "unavailable",
          unavailableReason: "writingCheckEntitlementRequired",
          appearance: {
            highlight: {
              style: "underline",
              grammarColor: "#FF2D55",
              fluencyColor: "#007AFF",
            },
            diff: {
              additionColor: "#34C759",
              deletionColor: "#FF3B30",
              showHiddenWhitespace: true,
            },
          },
          interaction: DEFAULT_PRESENTATION_INTERACTION,
          suggestions: [],
        },
      },
    });
    await expect(events.next()).resolves.toMatchObject({
      value: {
        event: {
          type: "presentationContentReplaced",
          content: {
            status: "unavailable",
            unavailableReason: "writingCheckEntitlementRequired",
          },
        },
      },
    });

    frames.push({
      type: "event",
      sequence: 3,
      epoch: "epoch-1",
      event: {
        type: "presentationContentReplaced",
        checkId: "check-3",
        content: {
          documentRevision: "doc:0",
          status: "unavailable",
          unavailableReason: "futureReason",
          appearance: {
            highlight: {
              style: "underline",
              grammarColor: "#FF2D55",
              fluencyColor: "#007AFF",
            },
            diff: {
              additionColor: "#34C759",
              deletionColor: "#FF3B30",
              showHiddenWhitespace: true,
            },
          },
          interaction: DEFAULT_PRESENTATION_INTERACTION,
          suggestions: [],
        },
      },
    });
    await expect(events.next()).rejects.toThrow(TransportProtocolError);
    await session.close();
  });

  it("normalizes an invalid endpoint into the generic fatal connection contract", async () => {
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      endpointLocator: {
        locate: async () => {
          throw new EndpointDescriptorError("invalid descriptor");
        },
      },
    });

    const connection = transport.connect(new AbortController().signal);
    await expect(connection).rejects.toBeInstanceOf(EngineConnectionError);
    await expect(connection).rejects.toMatchObject({ recoverability: "fatal" });
  });

  it("preserves an incompatible endpoint protocol as an explicit fatal error", async () => {
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      endpointLocator: {
        locate: async () => {
          throw new EndpointProtocolVersionError({ major: 0, minor: 9 });
        },
      },
    });

    const connection = transport.connect(new AbortController().signal);
    await expect(connection).rejects.toThrow(IncompatibleProtocolError);
    await expect(connection).rejects.toMatchObject({
      recoverability: "fatal",
      clientProtocol: { major: 1, minor: 0 },
      serverProtocol: { major: 0, minor: 9 },
    });
  });

  it("serializes concurrent command writes in sequence order", async () => {
    const frames = new AsyncQueue<unknown>();
    const sent: unknown[] = [];
    let releaseFirstCommand: (() => void) | undefined;
    let sends = 0;
    const connector: FrameConnector = {
      connect: async () => ({
        send: async (value) => {
          sends += 1;
          if (sends === 1) {
            sent.push(value);
            frames.push({
              type: "welcome",
              protocol: { major: 1, minor: 0 },
              serverEpoch: "epoch-1",
              runResumed: false,
              limits: { maxFrameBytes: 8_388_608, maxSources: 2, maxSourceBytes: 1_048_576 },
              capabilities: [],
            });
            return;
          }
          if (sends === 2) {
            await new Promise<void>((resolve) => {
              releaseFirstCommand = resolve;
            });
          }
          sent.push(value);
        },
        receive: () => frames,
        close: async () => frames.close(),
      }),
    };
    const session = await new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    }).connect(new AbortController().signal);

    const first = session.send({
      type: "openDocument",
      snapshot: {
        revision: "doc:0",
        sources: [{ sourceId: "document", text: "first", sourceSyntax: "plainText" }],
      },
    });
    const second = session.send({
      type: "replaceDocument",
      snapshot: {
        revision: "doc:1",
        sources: [{ sourceId: "document", text: "second", sourceSyntax: "plainText" }],
      },
    });
    await vi.waitFor(() => expect(releaseFirstCommand).toBeTypeOf("function"));
    expect(sends).toBe(2);

    releaseFirstCommand?.();
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { sequence: 1 },
      { sequence: 2 },
    ]);
    expect(sent.slice(1)).toMatchObject([
      { type: "command", sequence: 1, command: { type: "openDocument" } },
      { type: "command", sequence: 2, command: { type: "replaceDocument" } },
    ]);
    await session.close();
  });

  it("closes the connection after sending the UInt32-max command sequence", async () => {
    const frames = new AsyncQueue<unknown>();
    const sent: unknown[] = [];
    const close = vi.fn(async () => frames.close());
    const connector: FrameConnector = {
      connect: async () => ({
        send: async (value) => {
          sent.push(value);
          if (sent.length === 1) {
            frames.push({
              type: "welcome",
              protocol: { major: 1, minor: 0 },
              serverEpoch: "epoch-1",
              runResumed: false,
              limits: { maxFrameBytes: 8_388_608, maxSources: 2, maxSourceBytes: 1_048_576 },
              capabilities: [],
            });
          }
        },
        receive: () => frames,
        close,
      }),
    };
    const session = await new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    }).connect(new AbortController().signal);
    (session as unknown as { commandSequence: number }).commandSequence =
      0xffff_fffe;

    await expect(
      session.send({ type: "closeDocument" }, "last-command"),
    ).resolves.toEqual({ sequence: 0xffff_ffff, id: "last-command" });
    expect(sent.at(-1)).toMatchObject({ sequence: 0xffff_ffff });
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the connection after delivering the UInt32-max event sequence", async () => {
    const frames = new AsyncQueue<unknown>();
    const close = vi.fn(async () => frames.close());
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: { maxFrameBytes: 8_388_608, maxSources: 2, maxSourceBytes: 1_048_576 },
        capabilities: [],
      });
    });
    connector.connect = async (): Promise<FrameConnection> => {
      let sends = 0;
      return {
        send: async () => {
          sends += 1;
          if (sends === 1) {
            frames.push({
              type: "welcome",
              protocol: { major: 1, minor: 0 },
              serverEpoch: "epoch-1",
              runResumed: false,
              limits: { maxFrameBytes: 8_388_608, maxSources: 2, maxSourceBytes: 1_048_576 },
              capabilities: [],
            });
          }
        },
        receive: () => frames,
        close,
      };
    };
    const session = await new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    }).connect(new AbortController().signal);
    (session as unknown as { expectedEventSequence: number }).expectedEventSequence =
      0xffff_ffff;
    const events = session.events(new AbortController().signal)[Symbol.asyncIterator]();
    frames.push({
      type: "event",
      sequence: 0xffff_ffff,
      epoch: "epoch-1",
      event: { type: "documentAccepted", revision: "doc:0" },
    });

    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: { sequence: 0xffff_ffff },
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("enforces the decoded UTF-8 source limit before sending a command", async () => {
    const frames = new AsyncQueue<unknown>();
    const sent: unknown[] = [];
    const connector = connectionConnector(frames, sent, () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: {
          maxFrameBytes: 8_388_608,
          maxSources: 2,
          maxSourceBytes: 1_048_576,
        },
        capabilities: [],
      });
    });
    const session = await new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    }).connect(new AbortController().signal);
    const exactLimit = "😀".repeat(262_144);

    await expect(
      session.send({
        type: "openDocument",
        snapshot: {
          revision: "doc:over-limit",
          sources: [
            {
              sourceId: "document",
              text: `${exactLimit}a`,
              sourceSyntax: "plainText",
            },
          ],
        },
      }),
    ).rejects.toThrow("at most 1048576 UTF-8 bytes");
    expect(sent).toHaveLength(1);

    await expect(
      session.send({
        type: "openDocument",
        snapshot: {
          revision: "doc:at-limit",
          sources: [
            {
              sourceId: "document",
              text: exactLimit,
              sourceSyntax: "plainText",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ sequence: 1 });
    expect(sent).toHaveLength(2);
    await session.close();
  });

  it("validates every client-sent identifier and identifier-set boundary", async () => {
    const frames = new AsyncQueue<unknown>();
    const sent: unknown[] = [];
    const connector = connectionConnector(frames, sent, () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: {
          maxFrameBytes: 8_388_608,
          maxSources: 2,
          maxSourceBytes: 1_048_576,
        },
        capabilities: [],
      });
    });
    const session = await new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    }).connect(new AbortController().signal);
    const snapshot = {
      revision: "doc:0",
      sources: [
        { sourceId: "document", text: "draft", sourceSyntax: "plainText" },
      ],
    } as const;
    const cases: readonly {
      readonly label: string;
      readonly command: ClientCommand;
      readonly commandId?: string;
      readonly message: string;
    }[] = [
      {
        label: "command ID",
        command: { type: "closeDocument" },
        commandId: "command id",
        message: "command.id",
      },
      {
        label: "snapshot revision",
        command: {
          type: "openDocument",
          snapshot: { ...snapshot, revision: "doc 0" },
        },
        message: "snapshot.revision",
      },
      {
        label: "snapshot source ID",
        command: {
          type: "openDocument",
          snapshot: {
            ...snapshot,
            sources: [{ ...snapshot.sources[0], sourceId: "document\n" }],
          },
        },
        message: "snapshot.sources[0].sourceId",
      },
      {
        label: "duplicate snapshot source ID",
        command: {
          type: "openDocument",
          snapshot: {
            ...snapshot,
            sources: [snapshot.sources[0], snapshot.sources[0]],
          },
        },
        message: "snapshot source IDs must be duplicate-free",
      },
      {
        label: "attention revision",
        command: {
          type: "updateAttention",
          revision: "doc 0",
          attention: { sourceId: "document", visibleRanges: [] },
        },
        message: "updateAttention.revision",
      },
      {
        label: "attention source ID",
        command: {
          type: "updateAttention",
          revision: "doc:0",
          attention: { sourceId: "document\t", visibleRanges: [] },
        },
        message: "updateAttention.attention.sourceId",
      },
      {
        label: "check revision",
        command: { type: "requestCheck", revision: "doc 0" },
        message: "requestCheck.revision",
      },
      {
        label: "forced language tag",
        command: {
          type: "requestCheck",
          revision: "doc:0",
          intent: { forcedLanguageTag: "en US" },
        },
        message: "requestCheck.intent.forcedLanguageTag",
      },
      {
        label: "check source ID",
        command: {
          type: "requestCheck",
          revision: "doc:0",
          intent: { sourceIds: ["document", "bad source"] },
        },
        message: "requestCheck.intent.sourceIds[1]",
      },
      {
        label: "duplicate check source ID",
        command: {
          type: "requestCheck",
          revision: "doc:0",
          intent: { sourceIds: ["document", "document"] },
        },
        message: "requestCheck.intent.sourceIds must be duplicate-free",
      },
      {
        label: "selection source ID",
        command: {
          type: "requestCheck",
          revision: "doc:0",
          intent: {
            selection: {
              sourceId: "bad source",
              range: { location: 0, length: 1 },
            },
          },
        },
        message: "requestCheck.intent.selection.sourceId",
      },
      {
        label: "action ID",
        command: {
          type: "performAction",
          actionId: "action id",
          kind: "apply",
          suggestion: { id: "suggestion-1", documentRevision: "doc:0" },
        },
        message: "performAction.actionId",
      },
      {
        label: "suggestion ID",
        command: {
          type: "performAction",
          actionId: "action-1",
          kind: "apply",
          suggestion: { id: "suggestion 1", documentRevision: "doc:0" },
        },
        message: "performAction.suggestion.id",
      },
      {
        label: "suggestion revision",
        command: {
          type: "performAction",
          actionId: "action-1",
          kind: "apply",
          suggestion: { id: "suggestion-1", documentRevision: "doc 0" },
        },
        message: "performAction.suggestion.documentRevision",
      },
      {
        label: "transaction ID",
        command: {
          type: "completeApply",
          transactionId: "transaction id",
          outcome: { status: "applied", snapshot },
        },
        message: "completeApply.transactionId",
      },
      {
        label: "Apply snapshot revision",
        command: {
          type: "completeApply",
          transactionId: "transaction-1",
          outcome: {
            status: "applied",
            snapshot: { ...snapshot, revision: "doc 1" },
          },
        },
        message: "completeApply.outcome.snapshot.revision",
      },
    ];

    for (const testCase of cases) {
      await expect(
        session.send(testCase.command, testCase.commandId),
        testCase.label,
      ).rejects.toThrow(testCase.message);
    }
    expect(sent).toHaveLength(1);

    const boundaryId = "a".repeat(128);
    await expect(
      session.send({ type: "closeDocument" }, boundaryId),
    ).resolves.toEqual({ sequence: 1, id: boundaryId });
    await expect(
      session.send({ type: "closeDocument" }, boundaryId),
    ).rejects.toThrow("command ID must be unique within a session");
    expect(sent).toHaveLength(2);
    await session.close();
  });

  it.each([
    {
      name: "an applied outcome with a reason",
      command: {
        type: "completeApply",
        transactionId: "transaction-1",
        outcome: {
          status: "applied",
          reason: "staleRevision",
          snapshot: {
            revision: "doc:1",
            sources: [{
              sourceId: "document",
              text: "draft",
              sourceSyntax: "plainText",
            }],
          },
        },
      },
    },
    {
      name: "an unavailable outcome with a reason",
      command: {
        type: "completeApply",
        transactionId: "transaction-1",
        outcome: { status: "unavailable", reason: "readOnly" },
      },
    },
    {
      name: "an indeterminate outcome with a reason",
      command: {
        type: "completeApply",
        transactionId: "transaction-1",
        outcome: { status: "indeterminate", reason: "nonAtomic" },
      },
    },
    {
      name: "a null check intent",
      command: { type: "requestCheck", revision: "doc:0", intent: null },
    },
    {
      name: "an unknown command discriminator",
      command: { type: "patchDocument" },
    },
    {
      name: "an unknown source syntax",
      command: {
        type: "openDocument",
        snapshot: {
          revision: "doc:0",
          sources: [{ sourceId: "document", text: "draft", sourceSyntax: "htmlDocument" }],
        },
      },
    },
    {
      name: "an empty check selection",
      command: {
        type: "requestCheck",
        revision: "doc:0",
        intent: {
          selection: { sourceId: "document", range: { location: 0, length: 0 } },
        },
      },
    },
    {
      name: "a check selection endpoint above the safe integer limit",
      command: {
        type: "requestCheck",
        revision: "doc:0",
        intent: {
          selection: {
            sourceId: "document",
            range: { location: Number.MAX_SAFE_INTEGER, length: 1 },
          },
        },
      },
    },
    {
      name: "both source IDs and a selection",
      command: {
        type: "requestCheck",
        revision: "doc:0",
        intent: {
          sourceIds: ["document"],
          selection: { sourceId: "document", range: { location: 0, length: 1 } },
        },
      },
    },
    {
      name: "an empty visible range",
      command: {
        type: "updateAttention",
        revision: "doc:0",
        attention: {
          sourceId: "document",
          visibleRanges: [{ location: 0, length: 0 }],
        },
      },
    },
    {
      name: "unordered visible ranges",
      command: {
        type: "updateAttention",
        revision: "doc:0",
        attention: {
          sourceId: "document",
          visibleRanges: [
            { location: 4, length: 1 },
            { location: 0, length: 1 },
          ],
        },
      },
    },
    {
      name: "overlapping visible ranges",
      command: {
        type: "updateAttention",
        revision: "doc:0",
        attention: {
          sourceId: "document",
          visibleRanges: [
            { location: 0, length: 3 },
            { location: 2, length: 1 },
          ],
        },
      },
    },
  ])("rejects $name before sending", async ({ command }) => {
    const frames = new AsyncQueue<unknown>();
    const sent: unknown[] = [];
    const connector = connectionConnector(frames, sent, () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: { maxFrameBytes: 8_388_608, maxSources: 2, maxSourceBytes: 1_048_576 },
        capabilities: [],
      });
    });
    const session = await new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    }).connect(new AbortController().signal);

    await expect(
      session.send(command as ClientCommand, "invalid-command"),
    ).rejects.toThrow(TransportProtocolError);
    expect(sent).toHaveLength(1);
    await session.close();
  });

  it("fails closed on an unknown action rejection reason", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: { maxFrameBytes: 8_388_608, maxSources: 2, maxSourceBytes: 1_048_576 },
        capabilities: [],
      });
    });
    const session = await new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: endpointLocator(),
    }).connect(new AbortController().signal);
    const events = session.events(new AbortController().signal)[Symbol.asyncIterator]();
    frames.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      event: {
        type: "actionRejected",
        actionId: "action-1",
        reason: "futureReason",
      },
    });

    await expect(events.next()).rejects.toThrow(TransportProtocolError);
    await session.close();
  });

  it.each([
    {
      name: "ascending order",
      edits: [
        { range: { location: 0, length: 1 }, expectedText: "a", replacement: "b" },
        { range: { location: 2, length: 1 }, expectedText: "c", replacement: "d" },
      ],
    },
    {
      name: "an ordering tie",
      edits: [
        { range: { location: 2, length: 0 }, expectedText: "", replacement: "x" },
        { range: { location: 2, length: 0 }, expectedText: "", replacement: "y" },
      ],
    },
    {
      name: "overlap",
      edits: [
        { range: { location: 2, length: 2 }, expectedText: "cd", replacement: "x" },
        { range: { location: 1, length: 2 }, expectedText: "bc", replacement: "y" },
      ],
    },
    {
      name: "a no-op",
      edits: [
        { range: { location: 0, length: 1 }, expectedText: "a", replacement: "a" },
      ],
    },
  ])("rejects an Apply request with $name before delivery", async ({ edits }) => {
    const fixture = await connectedEventFixture();
    fixture.frames.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      event: {
        type: "applyRequested",
        actionId: "action-1",
        transactionId: "transaction-1",
        request: {
          expectedRevision: "doc:0",
          sourceId: "document",
          edits,
        },
      },
    });

    await expect(fixture.events.next()).rejects.toThrow(
      "Apply request edits must be descending without ties, overlaps, or no-ops",
    );
    await fixture.session.close();
  });

  it("rejects an incoming range whose endpoint exceeds the safe integer limit", async () => {
    const fixture = await connectedEventFixture();
    fixture.frames.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      event: {
        type: "applyRequested",
        actionId: "action-1",
        transactionId: "transaction-1",
        request: {
          expectedRevision: "doc:0",
          sourceId: "document",
          edits: [{
            range: { location: Number.MAX_SAFE_INTEGER, length: 1 },
            expectedText: "a",
            replacement: "b",
          }],
        },
      },
    });

    await expect(fixture.events.next()).rejects.toThrow(
      TransportProtocolError,
    );
    await fixture.session.close();
  });

  it.each([
    { code: "invalidSequence", fatal: false },
    { code: "invalidDocument", fatal: true },
    { code: "futureFault", fatal: false },
  ])("rejects the invalid fault severity pair %s", async ({ code, fatal }) => {
    const fixture = await connectedEventFixture();
    fixture.frames.push({
      type: "event",
      sequence: 1,
      epoch: "epoch-1",
      event: { type: "fault", code, fatal },
    });

    await expect(fixture.events.next()).rejects.toThrow(
      "Malformed fault severity pair",
    );
    await fixture.session.close();
  });

  it.each([
    {
      name: "event epoch",
      envelope: {
        type: "event",
        sequence: 1,
        epoch: "epoch 1",
        event: { type: "documentAccepted", revision: "doc:0" },
      },
    },
    {
      name: "cause command ID",
      envelope: {
        type: "event",
        sequence: 1,
        epoch: "epoch-1",
        causeCommandId: "command id",
        event: { type: "documentAccepted", revision: "doc:0" },
      },
    },
    {
      name: "document revision",
      envelope: {
        type: "event",
        sequence: 1,
        epoch: "epoch-1",
        event: { type: "documentAccepted", revision: "doc 0" },
      },
    },
    {
      name: "action ID",
      envelope: {
        type: "event",
        sequence: 1,
        epoch: "epoch-1",
        event: { type: "actionCompleted", actionId: "action id" },
      },
    },
  ])("rejects an invalid server-sent $name", async ({ envelope }) => {
    const fixture = await connectedEventFixture();
    fixture.frames.push(envelope);

    await expect(fixture.events.next()).rejects.toThrow(
      "1-to-128-byte visible ASCII identifier",
    );
    await fixture.session.close();
  });
});

describe("Integration Protocol 1.0 source syntaxes", () => {
  it("closes the wire registry over the four base values in schema order", () => {
    expect(SOURCE_SYNTAXES).toHaveLength(4);
    expect(SOURCE_SYNTAXES).toEqual([
      "plainText",
      "markdownDocument",
      "markdownDocumentHardLineBreaks",
      "latexDocument",
    ]);
  });

  it("accepts the immovable-line-ending Markdown syntax the Obsidian host declares", () => {
    expect(isSourceSyntax("markdownDocumentHardLineBreaks")).toBe(true);
  });

  it.each([
    "markdownDocumentHardLinebreaks",
    "markdownDocumentHardLineBreak",
    "markdownHardLineBreaks",
    "latexDocumentHardLineBreaks",
    "htmlDocument",
  ])("rejects the unknown source syntax %s", (syntax) => {
    expect(isSourceSyntax(syntax)).toBe(false);
  });
});

function endpointLocator(): EndpointLocator {
  return {
    locate: async () => ({
      version: 1,
      socketPath: "/private/tmp/refine-1/integration.sock",
      launchToken: VALID_LAUNCH_TOKEN,
      serverEpoch: "epoch-1",
      protocolMajor: 1,
      protocolMinor: 0,
      pid: 123,
    }),
  };
}

function connectionConnector(
  frames: AsyncQueue<unknown>,
  sent: unknown[],
  afterFirstSend: () => void,
): FrameConnector {
  return {
    connect: async (): Promise<FrameConnection> => {
      let sends = 0;
      return {
        send: async (value) => {
          sent.push(value);
          sends += 1;
          if (sends === 1) {
            afterFirstSend();
          }
        },
        receive: () => frames,
        close: async () => frames.close(),
      };
    },
  };
}

function decodeRawFrame(json: string): unknown {
  const body = Buffer.from(json, "utf8");
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length);
  body.copy(frame, 4);
  return new FrameDecoder().push(frame)[0];
}

async function connectedEventFixture() {
  const frames = new AsyncQueue<unknown>();
  const connector = connectionConnector(frames, [], () => {
    frames.push({
      type: "welcome",
      protocol: { major: 1, minor: 0 },
      serverEpoch: "epoch-1",
      runResumed: false,
      limits: { maxFrameBytes: 8_388_608, maxSources: 2, maxSourceBytes: 1_048_576 },
      capabilities: [],
    });
  });
  const session = await new RefineTransport({
    client: { id: "test-client", version: "0.1.0", host: "test-host" },
    connector,
    endpointLocator: endpointLocator(),
  }).connect(new AbortController().signal);
  return {
    frames,
    session,
    events: session.events(new AbortController().signal)[Symbol.asyncIterator](),
  };
}

function checkingProgressEvent(
  progress: unknown = undefined,
  status: "pending" | "checking" | "complete" | "unavailable" | "closed" = "checking",
  sequence = 1,
): unknown {
  return {
    type: "event",
    sequence,
    epoch: "epoch-1",
    event: {
      type: "presentationContentReplaced",
      checkId: "check-progress",
      content: {
        documentRevision: "doc:0",
        status,
        ...(status === "complete" ? { coverage: "full" } : {}),
        ...(status === "unavailable" ? { unavailableReason: "checkFailed" } : {}),
        ...(progress === undefined ? {} : { progress }),
        appearance: {
          highlight: {
            style: "underline",
            grammarColor: "#FF2D55",
            fluencyColor: "#007AFF",
          },
          diff: {
            additionColor: "#34C759",
            deletionColor: "#FF3B30",
            showHiddenWhitespace: true,
          },
        },
        interaction: DEFAULT_PRESENTATION_INTERACTION,
        suggestions: [],
      },
    },
  };
}

function completePresentationEvent(
  interaction: unknown,
  activationRange: unknown = { location: 0, length: 14 },
): unknown {
  return {
    type: "event",
    sequence: 1,
    epoch: "epoch-1",
    event: {
      type: "presentationContentReplaced",
      checkId: "check-interaction",
      content: {
        documentRevision: "doc:0",
        status: "complete",
        coverage: "full",
        appearance: {
          highlight: {
            style: "underline",
            grammarColor: "#FF2D55",
            fluencyColor: "#007AFF",
          },
          diff: {
            additionColor: "#34C759",
            deletionColor: "#FF3B30",
            showHiddenWhitespace: true,
          },
        },
        interaction,
        suggestions: [{
          id: "suggestion-interaction",
          sourceId: "document",
          kind: "grammar",
          attribution: {
            languageDisplayName: "English (American)",
            textDirection: "ltr",
            checkModelDisplayName: "On-Device (Gemma)",
          },
          activationRange,
          highlightRanges: [{ location: 7, length: 2 }],
          diff: [
            { kind: "delete", text: "an" },
            { kind: "insert", text: "a" },
          ],
          availableActions: ["apply"],
        }],
      },
    },
  };
}
