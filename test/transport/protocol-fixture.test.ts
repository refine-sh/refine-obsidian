import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { AsyncQueue } from "../../src/shared/async-queue";
import type { EndpointLocator } from "../../src/transport/endpoint-locator";
import {
  RefineTransport,
  type FrameConnection,
  type FrameConnector,
} from "../../src/transport/refine-transport";
import type {
  ClientCommandEnvelope,
  HelloFrame,
  ServerEventEnvelope,
  WelcomeFrame,
} from "../../src/transport/wire";

interface ProtocolFixture {
  readonly hello: HelloFrame;
  readonly welcome: WelcomeFrame;
  readonly openDocument: ClientCommandEnvelope;
  readonly presentation: ServerEventEnvelope;
  readonly applyRequested: ServerEventEnvelope;
  readonly completeApply: ClientCommandEnvelope;
}

describe("integration protocol V2 golden transcript", () => {
  it("is consumed without translation by the TypeScript transport", async () => {
    const fixture = await loadFixture();
    expect(fixture.presentation).toMatchObject({
      event: {
        type: "presentationContentReplaced",
        content: {
          suggestions: [
            {},
            {
              id: "suggestion-space",
              highlightRanges: [
                { location: 21, length: 1 },
              ],
              diff: [
                { kind: "unchanged", text: "link" },
                { kind: "insert", text: " " },
                { kind: "unchanged", text: "or" },
              ],
            },
          ],
        },
      },
    });
    const frames = new AsyncQueue<unknown>();
    const sent: unknown[] = [];
    const connector: FrameConnector = {
      connect: async (): Promise<FrameConnection> => ({
        send: async (value) => {
          sent.push(value);
          if (sent.length === 1) {
            frames.push(fixture.welcome);
          }
        },
        receive: () => frames,
        close: async () => frames.close(),
      }),
    };
    const endpointLocator: EndpointLocator = {
      locate: async () => ({
        version: 1,
        socketPath: "/private/tmp/refine-fixture/s",
        launchToken: fixture.hello.launchToken,
        serverEpoch: fixture.welcome.serverEpoch,
        protocolMajor: 2,
        pid: 123,
      }),
    };
    const session = await new RefineTransport({
      client: fixture.hello.client,
      endpointLocator,
      connector,
    }).connect(new AbortController().signal, {
      runId: fixture.hello.runId,
    });

    expect(sent[0]).toEqual(fixture.hello);
    expect(session.runResumed).toBe(fixture.welcome.runResumed);
    await session.send(
      fixture.openDocument.command,
      fixture.openDocument.id,
    );
    expect(sent[1]).toEqual(fixture.openDocument);

    const events = session.events(new AbortController().signal)[Symbol.asyncIterator]();
    frames.push(fixture.presentation);
    frames.push(fixture.applyRequested);
    await expect(events.next()).resolves.toEqual({
      done: false,
      value: fixture.presentation,
    });
    await expect(events.next()).resolves.toEqual({
      done: false,
      value: fixture.applyRequested,
    });

    await session.close();
  });
});

async function loadFixture(): Promise<ProtocolFixture> {
  const data = await readFile(
    new URL("../fixtures/integration-protocol-v2.json", import.meta.url),
    "utf8",
  );
  return JSON.parse(data) as ProtocolFixture;
}
