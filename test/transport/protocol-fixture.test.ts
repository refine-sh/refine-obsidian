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
  HandshakeRejectedFrame,
  HelloFrame,
  ServerEventEnvelope,
  WelcomeFrame,
} from "../../src/transport/wire";

interface ProtocolFixture {
  readonly hello: HelloFrame;
  readonly rejection: HandshakeRejectedFrame;
  readonly welcome: WelcomeFrame;
  readonly openDocument: ClientCommandEnvelope;
  readonly updateAttention: ClientCommandEnvelope;
  readonly selectionCheck: ClientCommandEnvelope;
  readonly checkingPresentation: ServerEventEnvelope;
  readonly presentation: ServerEventEnvelope;
  readonly explanationStarted: ServerEventEnvelope;
  readonly reportCompleted: ServerEventEnvelope;
  readonly applyRequested: ServerEventEnvelope;
  readonly completeApply: ClientCommandEnvelope;
}

describe("integration protocol V2 golden transcript", () => {
  it("is consumed without translation by the TypeScript transport", async () => {
    const fixture = await loadFixture();
    expect(fixture.hello).toMatchObject({
      protocol: { major: 2, minor: 5 },
    });
    expect(fixture.openDocument).toMatchObject({
      command: {
        type: "openDocument",
        snapshot: {
          sources: [{ sourceSyntax: "markdownDocument" }],
        },
      },
    });
    expect(fixture.updateAttention).toMatchObject({
      sequence: 2,
      command: {
        type: "updateAttention",
        revision: "fixture:0",
        attention: {
          sourceId: "document",
          caretOffset: 21,
          visibleRanges: [{ location: 0, length: 23 }],
        },
      },
    });
    expect(fixture.rejection).toEqual({
      type: "rejected",
      reason: "incompatibleProtocol",
      protocol: { major: 2, minor: 5 },
    });
    expect(fixture.checkingPresentation).toMatchObject({
      event: {
        type: "presentationContentReplaced",
        content: {
          status: "checking",
          progress: { completedUnitCount: 1, totalUnitCount: 3 },
          interaction: {
            automaticChecksEnabled: true,
            quickApply: {
              enabled: true,
              applyKey: "tab",
              dismissKey: "escape",
              activationStyle: "showTipAndHighlight",
            },
          },
        },
      },
    });
    expect(fixture.presentation).toMatchObject({
      event: {
        type: "presentationContentReplaced",
        content: {
          interaction: { automaticChecksEnabled: false },
          suggestions: [
            {
              id: "suggestion-article",
              activationRange: { location: 8, length: 2 },
            },
            {
              id: "suggestion-space",
              activationRange: { location: 11, length: 12 },
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
    expect(fixture.explanationStarted).toMatchObject({
      event: {
        type: "explanationReplaced",
        update: {
          status: "started",
          attribution: { modelDisplayName: "OpenRouter (GPT-5.6)" },
        },
      },
    });
    expect(fixture.reportCompleted).toMatchObject({
      event: { type: "actionCompleted", actionId: "action-report" },
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
        protocolMinor: 5,
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
    await session.send(
      fixture.updateAttention.command,
      fixture.updateAttention.id,
    );
    expect(sent[2]).toEqual(fixture.updateAttention);
    await session.send(
      fixture.selectionCheck.command,
      fixture.selectionCheck.id,
    );
    expect(sent[3]).toEqual(fixture.selectionCheck);

    const events = session.events(new AbortController().signal)[Symbol.asyncIterator]();
    frames.push(fixture.checkingPresentation);
    frames.push(fixture.presentation);
    frames.push(fixture.applyRequested);
    await expect(events.next()).resolves.toEqual({
      done: false,
      value: fixture.checkingPresentation,
    });
    await expect(events.next()).resolves.toEqual({
      done: false,
      value: fixture.presentation,
    });
    await expect(events.next()).resolves.toEqual({
      done: false,
      value: fixture.applyRequested,
    });

    await session.send(
      fixture.completeApply.command,
      fixture.completeApply.id,
    );
    expect(sent[4]).toEqual(fixture.completeApply);

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
