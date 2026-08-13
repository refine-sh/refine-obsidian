import { describe, expect, it, vi } from "vitest";

import { EngineConnectionError } from "../../src/transport/engine-connection-error";
import { AsyncQueue } from "../../src/shared/async-queue";
import {
  EndpointDescriptorError,
  type EndpointLocator,
} from "../../src/transport/endpoint-locator";
import {
  RefineTransport,
  EndpointReplacedError,
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
        protocol: { major: 1, minor: 0 },
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
      protocol: { major: 1, minor: 0 },
      client: { id: "test-client", version: "0.1.0", host: "test-host" },
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
          suggestions: [
            {
              id: "suggestion-1",
              sourceId: "document",
              kind: "grammar",
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
          content: { suggestions: [{ id: "suggestion-1" }] },
        },
      },
    });

    frames.push({
      type: "event",
      sequence: 4,
      epoch: "epoch-1",
      event: { type: "documentAccepted", revision: "doc:0" },
    });
    await expect(events.next()).rejects.toThrow(TransportProtocolError);

    controller.abort();
    await session.close();
  });

  it("rejects a welcome from a replaced server epoch", async () => {
    const frames = new AsyncQueue<unknown>();
    const connector = connectionConnector(frames, [], () => {
      frames.push({
        type: "welcome",
        protocol: { major: 1, minor: 0 },
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
        protocol: { major: 1, minor: 0 },
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
      protocolMajor: 1,
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
