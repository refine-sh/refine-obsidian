import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { AsyncQueue } from "../../src/shared/async-queue";
import {
  parseEndpointDescriptor,
  type EndpointDescriptor,
  type EndpointLocator,
} from "../../src/transport/endpoint-locator";
import {
  FrameDecoder,
  FrameProtocolError,
} from "../../src/transport/frame-codec";
import {
  HandshakeRejectedError,
  RefineTransport,
  TransportProtocolError,
  type FrameConnection,
  type FrameConnector,
  type RefineTransportOptions,
  type RefineTransportSession,
} from "../../src/transport/refine-transport";
import type {
  ClientCommand,
  ClientCommandEnvelope,
  ServerEventEnvelope,
} from "../../src/transport/wire";

interface ProtocolPin {
  readonly artifactDirectory: string;
}

interface ProtocolManifest {
  readonly jsonPositiveCaseIds: readonly string[];
  readonly jsonNegativeCaseIds: readonly string[];
  readonly frameCaseIds: readonly string[];
  readonly stateScenarioIds: readonly string[];
}

interface VectorCollection {
  readonly formatVersion: number;
  readonly cases: readonly VectorCase[];
}

interface VectorCase {
  readonly id: string;
  readonly schema?: string;
  readonly value?: unknown;
  readonly documentText?: string;
  readonly expected?: "valid" | "valid-framing" | "invalid";
  readonly hex?: string;
  readonly generate?: Readonly<Record<string, unknown>>;
}

interface MutableSessionSequenceState {
  commandSequence: number;
  expectedEventSequence: number;
}

const execFileAsync = promisify(execFile);
const SOCKET_SCENARIOS = [
  "base-handshake",
  "golden-writing-session",
  "typed-rejections",
  "fatal-fault",
  "reconnect-resumed",
  "reconnect-lost-state",
  "sequence-exhaustion",
  "invalid-server-inputs",
] as const;
const NON_APPLICABLE_OUTBOUND_SEQUENCE_CASES = new Set([
  "command-sequence-zero",
  "negative-integer-is-outside-sequence-range",
  "command-sequence-over-uint32",
]);
const NON_APPLICABLE_NEGATIVE_CASES = [
  "capability-id-requires-reverse-domain-publisher",
  "command-sequence-over-uint32",
  "command-sequence-zero",
  "explanation-language-display-name-is-nonempty",
  "explanation-model-display-name-is-nonempty",
  "hello-capabilities-are-required",
  "hello-requires-exact-protocol-1.0",
  "negative-integer-is-outside-sequence-range",
  "range-sum-must-be-safe",
  "registry-ids-must-be-unique",
  "suggestion-check-model-display-name-is-nonempty",
  "suggestion-language-display-name-is-nonempty",
] as const;

describe("vendored Integration Protocol 1.0 vectors", () => {
  it("matches every shared case to the independent manifest inventories", async () => {
    const root = await artifactRoot();
    const manifest = await loadManifest(root);
    const inventories = await vectorInventories(root);

    expect(inventories.positive).toEqual(manifest.jsonPositiveCaseIds);
    expect(inventories.negative).toEqual(manifest.jsonNegativeCaseIds);
    expect(inventories.frames).toEqual(manifest.frameCaseIds);
    expect(inventories.states).toEqual(manifest.stateScenarioIds);
  });

  it("encodes every shared positive command envelope without translation", async () => {
    const root = await artifactRoot();
    const commands = await loadCollection(root, "vectors/json/positive/commands.json");
    const boundaries = await loadCollection(
      root,
      "vectors/json/positive/enum-and-boundary-coverage.json",
    );
    const cases = [
      ...commands.cases,
      ...boundaries.cases.filter((testCase) => testCase.generate?.kind === "sourceBytes"),
    ];

    for (const testCase of cases) {
      const envelope = materialize(testCase) as ClientCommandEnvelope;
      const fixture = await connectedFixture(undefined, envelope.sequence);
      await expect(
        fixture.session.send(envelope.command, envelope.id),
        testCase.id,
      ).resolves.toEqual({ sequence: envelope.sequence, id: envelope.id });
      expect(fixture.sent.at(-1), testCase.id).toEqual(envelope);
      await fixture.session.close();
    }
  });

  it("decodes every shared positive event envelope without translation", async () => {
    const root = await artifactRoot();
    const events = await loadCollection(root, "vectors/json/positive/events.json");

    for (const testCase of events.cases) {
      const envelope = materialize(testCase) as ServerEventEnvelope;
      const fixture = await connectedFixture(envelope.epoch);
      (fixture.session as unknown as MutableSessionSequenceState)
        .expectedEventSequence = envelope.sequence;
      const iterator = fixture.session.events(new AbortController().signal)[Symbol.asyncIterator]();
      fixture.frames.push(envelope);
      await expect(iterator.next(), testCase.id).resolves.toEqual({
        done: false,
        value: envelope,
      });
      await fixture.session.close();
    }
  });

  it("decodes every shared valid fault severity pair", async () => {
    const root = await artifactRoot();
    const faults = await loadCollection(
      root,
      "vectors/json/positive/fault-severity-pairs.json",
    );

    for (const testCase of faults.cases) {
      const event = materialize(testCase);
      const envelope = {
        type: "event",
        sequence: 1,
        epoch: "epoch-fixture",
        event,
      } as ServerEventEnvelope;
      const fixture = await connectedFixture(envelope.epoch);
      const iterator = fixture.session.events(new AbortController().signal)[Symbol.asyncIterator]();
      fixture.frames.push(envelope);
      await expect(iterator.next(), testCase.id).resolves.toEqual({
        done: false,
        value: envelope,
      });
      await fixture.session.close();
    }
  });

  it("rejects every shared negative case that crosses a client public seam", async () => {
    const root = await artifactRoot();
    const collections = await Promise.all([
      loadCollection(root, "vectors/json/negative/portable-json.json"),
      loadCollection(root, "vectors/json/negative/semantic-boundaries.json"),
      loadCollection(root, "vectors/json/negative/shape-and-enums.json"),
    ]);
    const skipped: string[] = [];

    for (const testCase of collections.flatMap((collection) => collection.cases)) {
      if (!await rejectAtPublicSeam(testCase)) {
        skipped.push(testCase.id);
      }
    }

    expect(skipped.sort()).toEqual([...NON_APPLICABLE_NEGATIVE_CASES].sort());
  });

  it("enforces every shared binary framing vector", async () => {
    const root = await artifactRoot();
    const framing = await loadCollection(root, "vectors/frames/framing.json");

    for (const testCase of framing.cases) {
      const frame = materializeFrame(testCase);
      const decoder = new FrameDecoder();
      if (testCase.expected === "invalid") {
        expect(() => {
          decoder.push(frame);
          decoder.finish();
        }, testCase.id).toThrow(FrameProtocolError);
        continue;
      }

      const decoded = decoder.push(frame);
      decoder.finish();
      expect(decoded, testCase.id).toHaveLength(1);
      if (testCase.expected === "valid") {
        expect(decoded[0], testCase.id).toEqual(
          JSON.parse(frame.subarray(4).toString("utf8")),
        );
      }
    }
  });

  it("executes every positive, negative, frame, and state vector with the shared runner", async () => {
    const artifact = await artifactRoot();
    const root = fileURLToPath(artifact);
    const manifest = await loadManifest(artifact);
    const expectedCounts = {
      positive: manifest.jsonPositiveCaseIds.length,
      negative: manifest.jsonNegativeCaseIds.length,
      frames: manifest.frameCaseIds.length,
      states: manifest.stateScenarioIds.length,
    };
    const script = String.raw`
import json, runpy, sys
from pathlib import Path
root = Path(sys.argv[1])
module = runpy.run_path(str(root / "runner" / "conformance.py"))
store = module["SchemaStore"](root)
for path in sorted((root / "schema").glob("*.json")):
    store.load(str(path.relative_to(root)))
published = module["published_capability_ids"](root, store)
positive, negative = module["verify_json_vectors"](root, store, published)
frames = module["verify_frame_vectors"](root, store, published)
states = module["verify_state_vectors"](root, store, published)
print(json.dumps({"positive": positive, "negative": negative, "frames": frames, "states": states}))
`;
    const { stdout } = await execFileAsync("python3", ["-c", script, root]);

    expect(JSON.parse(stdout)).toEqual(expectedCounts);
  });

  it.each(SOCKET_SCENARIOS)(
    "passes the shared %s live-socket scenario",
    async (scenario) => {
      const root = await artifactRootPath();
      const runner = resolve(root, "runner", "conformance.py");
      const client = fileURLToPath(
        new URL("../conformance/run-client.sh", import.meta.url),
      );
      const { stdout } = await execFileAsync(
        "python3",
        [
          runner,
          "--root",
          root,
          "socket",
          "--scenario",
          scenario,
          "--client",
          client,
        ],
        { maxBuffer: 1_048_576 },
      );

      expect(JSON.parse(stdout)).toEqual({
        scenario,
        status: "ok",
        transport: "AF_UNIX",
      });
    },
    10_000,
  );
});

async function rejectAtPublicSeam(testCase: VectorCase): Promise<boolean> {
  if (testCase.documentText !== undefined) {
    const decoder = new FrameDecoder();
    const payload = Buffer.from(testCase.documentText, "utf8");
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32BE(payload.length);
    payload.copy(frame, 4);
    expect(() => decoder.push(frame), testCase.id).toThrow(FrameProtocolError);
    return true;
  }

  const value = materialize(testCase);
  if (testCase.id === "root-array-is-not-a-message") {
    const decoder = new FrameDecoder();
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32BE(payload.length);
    payload.copy(frame, 4);
    expect(() => decoder.push(frame), testCase.id).toThrow(FrameProtocolError);
    return true;
  }
  if (typeof value === "string") {
    expect(() => new RefineTransport({
      client: { id: value, version: "1", host: "host" },
    }), testCase.id).toThrow(TypeError);
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  if ("socketPath" in value) {
    expect(() => parseEndpointDescriptor(JSON.stringify(value)), testCase.id).toThrow();
    return true;
  }
  if (value.type === "hello") {
    if (testCase.id === "hello-capabilities-are-required" ||
      testCase.id === "hello-requires-exact-protocol-1.0") {
      return false;
    }
    const client = requireRecord(value.client);
    const hostCapabilities = requireRecord(value.hostCapabilities);
    expect(() => new RefineTransport({
      client: {
        id: String(client.id),
        version: String(client.version),
        host: String(client.host),
      },
      capabilities: value.capabilities as string[],
      hostCapabilities: hostCapabilities as NonNullable<
        RefineTransportOptions["hostCapabilities"]
      >,
    }), testCase.id).toThrow();
    return true;
  }
  if (value.type === "welcome" || value.type === "rejected") {
    const connect = connectWithHandshakeResponse(value);
    const failure = await connect.catch((error: unknown) => error);
    expect(failure, testCase.id).toBeInstanceOf(TransportProtocolError);
    expect(failure, testCase.id).not.toBeInstanceOf(HandshakeRejectedError);
    return true;
  }
  if (value.type === "command") {
    if (NON_APPLICABLE_OUTBOUND_SEQUENCE_CASES.has(testCase.id)) {
      return false;
    }
    const envelope = value as unknown as ClientCommandEnvelope;
    const fixture = await connectedFixture();
    await expect(
      fixture.session.send(envelope.command as ClientCommand, envelope.id),
      testCase.id,
    ).rejects.toBeInstanceOf(TransportProtocolError);
    expect(fixture.sent).toHaveLength(1);
    await fixture.session.close();
    return true;
  }
  if (value.type === "event") {
    const envelope = value as unknown as ServerEventEnvelope;
    const fixture = await connectedFixture(
      typeof envelope.epoch === "string" ? envelope.epoch : undefined,
    );
    if (Number.isInteger(envelope.sequence)) {
      (fixture.session as unknown as MutableSessionSequenceState)
        .expectedEventSequence = envelope.sequence;
    }
    const iterator = fixture.session.events(new AbortController().signal)[Symbol.asyncIterator]();
    fixture.frames.push(value);
    await expect(iterator.next(), testCase.id).rejects.toBeInstanceOf(
      TransportProtocolError,
    );
    await fixture.session.close();
    return true;
  }
  return false;
}

async function connectWithHandshakeResponse(value: Record<string, unknown>): Promise<unknown> {
  const epoch = typeof value.serverEpoch === "string" ? value.serverEpoch : "epoch-fixture";
  const frames = new AsyncQueue<unknown>();
  const connector = connectorFor(frames, [], () => frames.push(value));
  return new RefineTransport({
    client: { id: "test-client", version: "1", host: "test-host" },
    endpointLocator: fixedEndpoint(epoch),
    connector,
  }).connect(new AbortController().signal, { runId: "run-fixture" });
}

async function connectedFixture(
  epoch = "epoch-fixture",
  nextCommandSequence = 1,
): Promise<{
  readonly frames: AsyncQueue<unknown>;
  readonly sent: unknown[];
  readonly session: RefineTransportSession;
}> {
  const frames = new AsyncQueue<unknown>();
  const sent: unknown[] = [];
  const connector = connectorFor(frames, sent, () => frames.push({
    type: "welcome",
    protocol: { major: 1, minor: 0 },
    serverEpoch: epoch,
    runResumed: false,
    limits: {
      maxFrameBytes: 8_388_608,
      maxSources: 2,
      maxSourceBytes: 1_048_576,
    },
    capabilities: [],
  }));
  const session = await new RefineTransport({
    client: { id: "test-client", version: "1", host: "test-host" },
    endpointLocator: fixedEndpoint(epoch),
    connector,
  }).connect(new AbortController().signal, { runId: "run-fixture" });
  (session as unknown as MutableSessionSequenceState).commandSequence =
    nextCommandSequence - 1;
  return { frames, sent, session };
}

function connectorFor(
  frames: AsyncQueue<unknown>,
  sent: unknown[],
  afterHello: () => void,
): FrameConnector {
  return {
    connect: async (): Promise<FrameConnection> => ({
      send: async (value) => {
        sent.push(value);
        if (sent.length === 1) {
          afterHello();
        }
      },
      receive: () => frames,
      close: async () => frames.close(),
    }),
  };
}

function fixedEndpoint(serverEpoch: string): EndpointLocator {
  const endpoint: EndpointDescriptor = {
    version: 1,
    socketPath: "/private/tmp/refine-fixture/socket",
    launchToken: "A".repeat(64),
    serverEpoch,
    protocolMajor: 1,
    protocolMinor: 0,
    pid: 123,
  };
  return { locate: async () => endpoint };
}

function materialize(testCase: VectorCase): unknown {
  if (testCase.value !== undefined) {
    return testCase.value;
  }
  const generate = testCase.generate;
  if (generate?.kind === "helloCapabilities") {
    const count = Number(generate.count);
    return {
      type: "hello",
      protocol: { major: 1, minor: 0 },
      client: { id: "com.example.writer", version: "1", host: "host" },
      hostCapabilities: { interceptableSuggestionActionKeys: [] },
      runId: "run",
      launchToken: "A".repeat(64),
      capabilities: Array.from(
        { length: count },
        (_value, index) => `com.example.feature-${index}.v1`,
      ),
    };
  }
  if (generate?.kind === "sourceBytes") {
    return {
      type: "command",
      sequence: 1,
      id: "command-source-limit",
      command: {
        type: "openDocument",
        snapshot: {
          revision: "revision",
          sources: [{
            sourceId: "document",
            text: "a".repeat(Number(generate.bytes)),
            sourceSyntax: "plainText",
          }],
        },
      },
    };
  }
  if (generate?.kind === "invalidProgress") {
    return presentationEnvelope("checking", {
      progress: { completedUnitCount: 2, totalUnitCount: 1 },
    });
  }
  if (generate?.kind === "invalidPresentation") {
    const status = String(generate.status);
    const defect = String(generate.defect);
    const extra: Record<string, unknown> = {};
    if (status === "complete" && defect !== "missingCoverage") {
      extra.coverage = "full";
    }
    if (status === "unavailable" && defect !== "missingReason") {
      extra.unavailableReason = "checkFailed";
    }
    if (defect === "progress") {
      extra.progress = { completedUnitCount: 0, totalUnitCount: 1 };
    } else if (defect === "suggestion") {
      extra.suggestions = [{}];
    } else if (defect === "closedMembers") {
      extra.coverage = "full";
      extra.unavailableReason = "checkFailed";
      extra.progress = { completedUnitCount: 0, totalUnitCount: 1 };
    } else if (defect === "duplicateActions") {
      extra.suggestions = [{
        id: "suggestion",
        sourceId: "document",
        kind: "grammar",
        attribution: {
          languageDisplayName: "English",
          textDirection: "ltr",
          checkModelDisplayName: "Model",
        },
        activationRange: { location: 0, length: 1 },
        highlightRanges: [{ location: 0, length: 1 }],
        diff: [{ kind: "unchanged", text: "a" }],
        availableActions: ["apply", "apply"],
      }];
    } else if (defect !== "missingCoverage" && defect !== "missingReason") {
      throw new Error(`Unsupported invalid presentation defect in ${testCase.id}`);
    }
    return presentationEnvelope(status, extra);
  }
  throw new Error(`Unsupported vector generator in ${testCase.id}`);
}

function presentationEnvelope(
  status: string,
  extra: Readonly<Record<string, unknown>>,
): unknown {
  return {
    type: "event",
    sequence: 1,
    epoch: "epoch",
    event: {
      type: "presentationContentReplaced",
      checkId: "check",
      content: {
        documentRevision: "revision",
        status,
        suggestions: [],
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
        interaction: {
          automaticChecksEnabled: true,
          quickApply: {
            enabled: true,
            applyKey: "tab",
            dismissKey: "escape",
            activationStyle: "showTipAndHighlight",
          },
        },
        ...extra,
      },
    },
  };
}

function materializeFrame(testCase: VectorCase): Buffer {
  if (testCase.hex !== undefined) {
    return Buffer.from(testCase.hex, "hex");
  }
  const size = Number(testCase.generate?.payloadBytes);
  const payload = Buffer.concat([
    Buffer.from('{"pad":"'),
    Buffer.alloc(size - 10, 0x61),
    Buffer.from('"}'),
  ]);
  const frame = Buffer.alloc(4 + size);
  frame.writeUInt32BE(size);
  payload.copy(frame, 4);
  return frame;
}

async function loadCollection(
  root: URL,
  path: string,
): Promise<VectorCollection> {
  const collection = JSON.parse(
    await readFile(new URL(path, root), "utf8"),
  ) as VectorCollection;
  expect(collection.formatVersion).toBe(1);
  return collection;
}

async function vectorInventories(root: URL): Promise<{
  readonly positive: readonly string[];
  readonly negative: readonly string[];
  readonly frames: readonly string[];
  readonly states: readonly string[];
}> {
  const collectionIds = async (directory: string): Promise<string[]> => {
    const files = (await readdir(new URL(directory, root)))
      .filter((path) => path.endsWith(".json"))
      .sort();
    const collections = await Promise.all(
      files.map((path) => loadCollection(root, `${directory}${path}`)),
    );
    return collections.flatMap((collection) => collection.cases.map(({ id }) => id));
  };
  const stateFiles = (await readdir(new URL("vectors/state/", root)))
    .filter((path) => path.endsWith(".json"))
    .sort();
  const states = await Promise.all(stateFiles.map(async (path) => {
    const value = JSON.parse(
      await readFile(new URL(`vectors/state/${path}`, root), "utf8"),
    ) as { readonly id: string };
    return value.id;
  }));
  return {
    positive: await collectionIds("vectors/json/positive/"),
    negative: await collectionIds("vectors/json/negative/"),
    frames: await collectionIds("vectors/frames/"),
    states,
  };
}

async function loadManifest(root: URL): Promise<ProtocolManifest> {
  return JSON.parse(
    await readFile(new URL("manifest.json", root), "utf8"),
  ) as ProtocolManifest;
}

async function artifactRootPath(): Promise<string> {
  return fileURLToPath(await artifactRoot());
}

async function artifactRoot(): Promise<URL> {
  const configured = process.env.REFINE_PROTOCOL_ROOT;
  if (configured !== undefined && configured.length > 0) {
    return new URL("./", pathToFileURL(resolve(configured, "placeholder")));
  }
  const fixtureRoot = new URL("../fixtures/refine-protocol/", import.meta.url);
  const pin = JSON.parse(
    await readFile(new URL("pin.json", fixtureRoot), "utf8"),
  ) as ProtocolPin;
  return new URL(`${pin.artifactDirectory}/`, fixtureRoot);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError("Expected an object");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
