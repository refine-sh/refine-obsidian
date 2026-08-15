import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PRESENTATION_INTERACTION } from "../../src/integration/types";
import { EngineConnectionError } from "../../src/transport/engine-connection-error";
import { AsyncQueue } from "../../src/shared/async-queue";
import {
  EndpointDescriptorError,
  EndpointProtocolVersionError,
  type EndpointLocator,
} from "../../src/transport/endpoint-locator";
import {
  RefineTransport,
  EndpointReplacedError,
  IncompatibleProtocolError,
  TransportProtocolError,
  type FrameConnection,
  type FrameConnector,
} from "../../src/transport/refine-transport";

describe("Refine transport handshake", () => {
  it("authenticates with the per-launch token and sequences commands and events", async () => {
    const frames = new AsyncQueue<unknown>();
    const sent: unknown[] = [];
    const connector = connectionConnector(frames, sent, () => {
      frames.push({
        type: "welcome",
        protocol: { major: 2, minor: 4 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: { maxFrameBytes: 4_194_304, maxSources: 2 },
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
      protocol: { major: 2, minor: 4 },
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
      launchToken: "secret-1",
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
            sourceSyntax: "mixed",
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
              sourceSyntax: "mixed",
            },
          ],
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

  it.each([
    ["a negative count", "checking", { completedUnitCount: -1, totalUnitCount: 5 }],
    ["a negative total", "checking", { completedUnitCount: 0, totalUnitCount: -1 }],
    ["a fractional count", "checking", { completedUnitCount: 1.5, totalUnitCount: 5 }],
    ["completed above total", "checking", { completedUnitCount: 6, totalUnitCount: 5 }],
    ["progress outside checking", "complete", { completedUnitCount: 1, totalUnitCount: 1 }],
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
        protocol: { major: 2, minor: 4 },
        serverEpoch: "epoch-2",
        runResumed: false,
        limits: { maxFrameBytes: 4_194_304, maxSources: 2 },
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

  it.each([
    [{ major: 2, minor: 3 }, "server"],
    [{ major: 2, minor: 5 }, "client"],
  ] as const)(
    "reports which component must be updated for welcome protocol %s",
    async (protocol, requiredUpdate) => {
      const frames = new AsyncQueue<unknown>();
      const connector = connectionConnector(frames, [], () => {
        frames.push({
          type: "welcome",
          protocol,
          serverEpoch: "epoch-1",
          runResumed: false,
          limits: { maxFrameBytes: 4_194_304, maxSources: 2 },
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
        requiredUpdate,
      });
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
        limits: { maxFrameBytes: 4_194_304, maxSources: 2 },
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

  it.each([
    [{ major: 2, minor: 3 }, "server"],
    [{ major: 2, minor: 5 }, "client"],
  ] as const)(
    "reports which component must be updated for a rejected protocol %s",
    async (protocol, requiredUpdate) => {
      const frames = new AsyncQueue<unknown>();
      const connector = connectionConnector(frames, [], () => {
        frames.push({
          type: "rejected",
          reason: "incompatibleProtocol",
          protocol,
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
        requiredUpdate,
      });
    },
  );

  it("rejects out-of-range protocol components in a handshake rejection", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "rejected",
        reason: "incompatibleProtocol",
        protocol: { major: 0x1_0000, minor: 0 },
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

  it("keeps a legacy pre-welcome close as a generic connection failure", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => frames.close());
    const transport = new RefineTransport({
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
      connector,
      endpointLocator: {
        locate: async () => ({
          version: 1,
          socketPath: "/private/tmp/refine-1/integration.sock",
          launchToken: "secret-1",
          serverEpoch: "epoch-1",
          protocolMajor: 2,
          pid: 123,
        }),
      },
    });

    const error = await transport
      .connect(new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TransportProtocolError);
    expect(error).not.toBeInstanceOf(IncompatibleProtocolError);
  });

  it("accepts a compatible welcome from a legacy same-major descriptor", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "welcome",
        protocol: { major: 2, minor: 4 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: { maxFrameBytes: 4_194_304, maxSources: 2 },
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
          launchToken: "secret-1",
          serverEpoch: "epoch-1",
          protocolMajor: 2,
          pid: 123,
        }),
      },
    });

    const session = await transport.connect(new AbortController().signal);

    expect(session.serverEpoch).toBe("epoch-1");
    await session.close();
  });

  it.each([
    [{ major: 1, minor: 0 }, "server"],
    [{ major: 3, minor: 0 }, "client"],
  ] as const)(
    "reports which component must be updated from endpoint protocol %s",
    async (receivedProtocol, requiredUpdate) => {
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
        requiredUpdate,
      });
      expect(connector.connect).not.toHaveBeenCalled();
    },
  );

  it("fails closed when presentation appearance contains an unknown field", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "welcome",
        protocol: { major: 2, minor: 4 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: { maxFrameBytes: 4_194_304, maxSources: 2 },
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

    await expect(events.next()).rejects.toThrow(TransportProtocolError);
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
      "an unknown interaction field",
      { ...DEFAULT_PRESENTATION_INTERACTION, unexpected: true },
    ],
    [
      "an unknown quickApply field",
      {
        automaticChecksEnabled: true,
        quickApply: {
          ...DEFAULT_PRESENTATION_INTERACTION.quickApply,
          unexpected: true,
        },
      },
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

  it("strictly decodes a suggestion activation range", async () => {
    const fixture = await connectedEventFixture();
    fixture.frames.push(completePresentationEvent(
      DEFAULT_PRESENTATION_INTERACTION,
      { location: 0, length: 14, unexpected: true },
    ));

    await expect(fixture.events.next()).rejects.toThrow(TransportProtocolError);
    await fixture.session.close();
  });

  it("decodes Protocol 2.4 unavailable reasons and rejects unknown ones", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "welcome",
        protocol: { major: 2, minor: 4 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: { maxFrameBytes: 4_194_304, maxSources: 2 },
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
          throw new EndpointProtocolVersionError({ major: 1, minor: 0 });
        },
      },
    });

    const connection = transport.connect(new AbortController().signal);
    await expect(connection).rejects.toThrow(IncompatibleProtocolError);
    await expect(connection).rejects.toMatchObject({
      recoverability: "fatal",
      requiredUpdate: "server",
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
              protocol: { major: 2, minor: 4 },
              serverEpoch: "epoch-1",
              runResumed: false,
              limits: { maxFrameBytes: 4_194_304, maxSources: 2 },
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
        sources: [{ sourceId: "document", text: "first", sourceSyntax: "mixed" }],
      },
    });
    const second = session.send({
      type: "replaceDocument",
      snapshot: {
        revision: "doc:1",
        sources: [{ sourceId: "document", text: "second", sourceSyntax: "mixed" }],
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

  it("fails closed on an unknown action rejection reason", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "welcome",
        protocol: { major: 2, minor: 4 },
        serverEpoch: "epoch-1",
        runResumed: false,
        limits: { maxFrameBytes: 4_194_304, maxSources: 2 },
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
});

function endpointLocator(): EndpointLocator {
  return {
    locate: async () => ({
      version: 1,
      socketPath: "/private/tmp/refine-1/integration.sock",
      launchToken: "secret-1",
      serverEpoch: "epoch-1",
      protocolMajor: 2,
      protocolMinor: 4,
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

async function connectedEventFixture() {
  const frames = new AsyncQueue<unknown>();
  const connector = connectionConnector(frames, [], () => {
    frames.push({
      type: "welcome",
      protocol: { major: 2, minor: 4 },
      serverEpoch: "epoch-1",
      runResumed: false,
      limits: { maxFrameBytes: 4_194_304, maxSources: 2 },
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
  status: "checking" | "complete" = "checking",
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
