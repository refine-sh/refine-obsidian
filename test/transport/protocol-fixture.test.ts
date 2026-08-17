import { createHash } from "node:crypto";
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
  readonly documentAccepted: ServerEventEnvelope;
  readonly updateAttention: ClientCommandEnvelope;
  readonly selectionCheck: ClientCommandEnvelope;
  readonly checkingPresentation: ServerEventEnvelope;
  readonly presentation: ServerEventEnvelope;
  readonly performExplain: ClientCommandEnvelope;
  readonly explanationStarted: ServerEventEnvelope;
  readonly performReport: ClientCommandEnvelope;
  readonly reportCompleted: ServerEventEnvelope;
  readonly performApply: ClientCommandEnvelope;
  readonly applyRequested: ServerEventEnvelope;
  readonly completeApply: ClientCommandEnvelope;
  readonly applyCompleted: ServerEventEnvelope;
  readonly closeDocument: ClientCommandEnvelope;
}

interface ProtocolArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly kind: string;
}

interface ProtocolManifest {
  readonly formatVersion: number;
  readonly releaseCandidate: string;
  readonly protocol: { readonly major: number; readonly minor: number };
  readonly artifactDigest: string;
  readonly baseArtifactDigest: string;
  readonly capabilityRegistryDigest: string;
  readonly artifacts: readonly ProtocolArtifact[];
}

interface ProtocolPin {
  readonly formatVersion: number;
  readonly releaseCandidate: string;
  readonly protocol: { readonly major: number; readonly minor: number };
  readonly protocolCommit: string;
  readonly artifactDirectory: string;
  readonly upstreamArtifactDigest: string;
  readonly vendoredSubset: {
    readonly artifactCount: number;
    readonly digest: string;
    readonly canonicalization: string;
    readonly includedKinds: readonly string[];
    readonly includedPaths: readonly string[];
  };
  readonly manifestDigest: string;
  readonly baseArtifactDigest: string;
  readonly capabilityRegistryDigest: string;
  readonly goldenVectorDigest: string;
}

interface GoldenVector {
  readonly formatVersion: number;
  readonly id: string;
  readonly messages: ProtocolFixture;
}

describe("integration protocol 1.0 golden transcript", () => {
  it("is consumed without translation by the TypeScript transport", async () => {
    const fixture = await loadFixture();
    expect(fixture.hello).toMatchObject({
      protocol: { major: 1, minor: 0 },
      capabilities: [],
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
      recovery: "none",
      protocol: { major: 1, minor: 0 },
      receivedProtocol: { major: 2, minor: 5 },
    });
    expect(fixture.welcome.limits).toEqual({
      maxFrameBytes: 8_388_608,
      maxSources: 2,
      maxSourceBytes: 1_048_576,
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
        protocolMajor: 1,
        protocolMinor: 0,
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
    const events = session.events(new AbortController().signal)[Symbol.asyncIterator]();
    const send = async (message: ClientCommandEnvelope): Promise<void> => {
      await session.send(message.command, message.id);
      expect(sent.at(-1)).toEqual(message);
    };
    const receive = async (message: ServerEventEnvelope): Promise<void> => {
      frames.push(message);
      await expect(events.next()).resolves.toEqual({
        done: false,
        value: message,
      });
    };

    await send(fixture.openDocument);
    await receive(fixture.documentAccepted);
    await send(fixture.updateAttention);
    await send(fixture.selectionCheck);
    await receive(fixture.checkingPresentation);
    await receive(fixture.presentation);
    await send(fixture.performExplain);
    await receive(fixture.explanationStarted);
    await send(fixture.performReport);
    await receive(fixture.reportCompleted);
    await send(fixture.performApply);
    await receive(fixture.applyRequested);
    await send(fixture.completeApply);
    await receive(fixture.applyCompleted);
    await send(fixture.closeDocument);

    await session.close();
  });
});

async function loadFixture(): Promise<ProtocolFixture> {
  const root = new URL("../fixtures/refine-protocol/", import.meta.url);
  const pin = JSON.parse(
    await readFile(new URL("pin.json", root), "utf8"),
  ) as ProtocolPin;
  expect(pin.formatVersion).toBe(1);
  expect(pin.protocol).toEqual({ major: 1, minor: 0 });
  expect(pin.protocolCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(pin.artifactDirectory).toBe(pin.upstreamArtifactDigest);

  const artifactRoot = new URL(`${pin.artifactDirectory}/`, root);
  const manifestData = await readFile(new URL("manifest.json", artifactRoot));
  expect(sha256(manifestData)).toBe(pin.manifestDigest);
  const manifest = JSON.parse(manifestData.toString("utf8")) as ProtocolManifest;
  expect(manifest.formatVersion).toBe(1);
  expect(manifest.releaseCandidate).toBe(pin.releaseCandidate);
  expect(manifest.protocol).toEqual(pin.protocol);
  expect(manifest.artifactDigest).toBe(pin.upstreamArtifactDigest);
  expect(manifest.baseArtifactDigest).toBe(pin.baseArtifactDigest);
  expect(manifest.capabilityRegistryDigest).toBe(
    pin.capabilityRegistryDigest,
  );

  const artifacts = manifest.artifacts.filter(
    (artifact) => pin.vendoredSubset.includedKinds.includes(artifact.kind) ||
      pin.vendoredSubset.includedPaths.includes(artifact.path),
  );
  expect(artifacts).toHaveLength(pin.vendoredSubset.artifactCount);
  for (const artifact of artifacts) {
    const data = await readFile(new URL(artifact.path, artifactRoot));
    expect(sha256(data)).toBe(artifact.sha256);
  }
  const canonicalArtifactList = artifacts.map(
    (artifact) => `${artifact.path}\0${artifact.sha256}\n`,
  ).join("");
  expect(pin.vendoredSubset.canonicalization).toBe(
    "manifest order: UTF-8 path, NUL, lowercase SHA-256, LF",
  );
  expect(sha256(canonicalArtifactList)).toBe(pin.vendoredSubset.digest);

  const goldenData = await readFile(
    new URL("vectors/state/golden-writing-session.json", artifactRoot),
  );
  expect(sha256(goldenData)).toBe(pin.goldenVectorDigest);
  const vector = JSON.parse(goldenData.toString("utf8")) as GoldenVector;
  expect(vector.formatVersion).toBe(1);
  expect(vector.id).toBe("golden-writing-session");
  return vector.messages;
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
