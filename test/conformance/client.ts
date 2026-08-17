import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { SuggestionActionKey } from "../../src/integration/types";
import {
  FileEndpointLocator,
  type EndpointDescriptor,
} from "../../src/transport/endpoint-locator";
import { EngineConnectionError } from "../../src/transport/engine-connection-error";
import {
  HandshakeRejectedError,
  RefineTransport,
  type RefineTransportSession,
} from "../../src/transport/refine-transport";
import { parseJSONObject } from "../../src/transport/strict-json";
import type {
  ClientCommand,
  ClientCommandEnvelope,
  HelloFrame,
  ServerEventEnvelope,
} from "../../src/transport/wire";

interface StateStep {
  readonly direction: "client" | "server";
  readonly message?: unknown;
  readonly messageRef?: string;
  readonly close?: boolean;
  readonly invalid?: string;
  readonly rawFrameHex?: string;
}

interface StateConnection {
  readonly expectedOutcome?: string;
  readonly sequenceStarts?: {
    readonly client?: number;
    readonly server?: number;
  };
  readonly steps: readonly StateStep[];
}

interface StateVector {
  readonly id: string;
  readonly socketRunnable: boolean;
  readonly messages?: Readonly<Record<string, unknown>>;
  readonly connections: readonly StateConnection[];
}

interface MutableSessionSequenceState {
  commandSequence: number;
  expectedEventSequence: number;
}

export async function runClient(arguments_: readonly string[]): Promise<void> {
  const { descriptorPath, scenarioId } = parseArguments(arguments_);
  const vector = await loadStateVector(scenarioId);
  assert.equal(vector.id, scenarioId, "scenario ID differs from its state vector");
  assert.equal(vector.socketRunnable, true, "scenario is not socket-runnable");

  const descriptor = await new FileEndpointLocator({ descriptorPath }).locate();
  for (const connection of vector.connections) {
    await driveConnection(vector, connection, descriptorPath, descriptor);
  }

  process.stdout.write(JSON.stringify({ status: "ok", scenario: scenarioId }));
}

async function driveConnection(
  vector: StateVector,
  connection: StateConnection,
  descriptorPath: string,
  descriptor: EndpointDescriptor,
): Promise<void> {
  const helloStep = connection.steps[0];
  assert(helloStep, "connection has no hello step");
  assert.equal(helloStep.direction, "client", "connection does not begin with client hello");
  const hello = requireHello(
    substitute(resolveMessage(vector, helloStep), descriptor),
  );
  const responseStep = connection.steps[1];
  assert(responseStep, "connection has no handshake response step");
  assert.equal(responseStep.direction, "server", "handshake response is not server-sent");

  const transport = new RefineTransport({
    client: hello.client,
    ...(hello.frontend === undefined ? {} : { frontend: hello.frontend }),
    hostCapabilities: hello.hostCapabilities,
    capabilities: hello.capabilities,
    endpointLocator: new FileEndpointLocator({ descriptorPath }),
  });
  let session: RefineTransportSession;
  try {
    session = await transport.connect(new AbortController().signal, {
      runId: hello.runId,
    });
  } catch (error) {
    verifyHandshakeFailure(vector, connection, responseStep, descriptor, error);
    return;
  }

  assert(
    responseStep.invalid === undefined && responseStep.rawFrameHex === undefined,
    "invalid handshake unexpectedly opened a session",
  );

  const expectedResponse = resolveOptionalMessage(vector, responseStep, descriptor);
  assert(expectedResponse, "successful handshake has no welcome message");
  assert.equal(record(expectedResponse, "handshake response").type, "welcome");
  assert.equal(session.serverEpoch, descriptor.serverEpoch);
  assert.equal(
    session.runResumed,
    record(expectedResponse, "welcome").runResumed,
  );

  const mutableSession = session as unknown as MutableSessionSequenceState;
  if (connection.sequenceStarts?.client !== undefined) {
    mutableSession.commandSequence = connection.sequenceStarts.client - 1;
  }
  if (connection.sequenceStarts?.server !== undefined) {
    mutableSession.expectedEventSequence = connection.sequenceStarts.server;
  }

  let events: AsyncIterator<ServerEventEnvelope> | undefined;
  try {
    for (const step of connection.steps.slice(2)) {
      if (step.close === true) {
        if (step.direction === "client") {
          await session.close();
        } else {
          events ??= session.events(new AbortController().signal)[Symbol.asyncIterator]();
          const closed = await events.next();
          assert.equal(closed.done, true, "server close did not end the event stream");
        }
        continue;
      }
      if (step.rawFrameHex !== undefined) {
        assert.equal(step.direction, "server", "raw invalid frame must be server-sent");
        events ??= session.events(new AbortController().signal)[Symbol.asyncIterator]();
        await expectFatalProtocolFailure(events, "invalid server frame");
        continue;
      }

      const message = substitute(resolveMessage(vector, step), descriptor);
      if (step.direction === "client") {
        const envelope = requireCommandEnvelope(message);
        const receipt = await session.send(envelope.command, envelope.id);
        assert.equal(receipt.sequence, envelope.sequence);
        assert.equal(receipt.id, envelope.id);
      } else {
        events ??= session.events(new AbortController().signal)[Symbol.asyncIterator]();
        if (step.invalid !== undefined) {
          await expectFatalProtocolFailure(events, `invalid server ${step.invalid}`);
          continue;
        }
        const received = await events.next();
        assert.equal(received.done, false, "server event stream ended early");
        assert.deepEqual(received.value, message);
      }
    }
  } finally {
    await session.close().catch(() => undefined);
  }
}

async function expectFatalProtocolFailure(
  events: AsyncIterator<ServerEventEnvelope>,
  label: string,
): Promise<void> {
  let failure: unknown;
  try {
    await events.next();
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof EngineConnectionError, `${label} crossed the session seam`);
  assert.equal(failure.recoverability, "fatal", `${label} was not fatal`);
}

function verifyHandshakeFailure(
  vector: StateVector,
  connection: StateConnection,
  responseStep: StateStep,
  descriptor: EndpointDescriptor,
  error: unknown,
): void {
  if (
    connection.expectedOutcome === "protocolError" &&
    (responseStep.invalid !== undefined || responseStep.rawFrameHex !== undefined)
  ) {
    assert(error instanceof EngineConnectionError, "invalid handshake crossed the transport seam");
    assert.equal(error.recoverability, "fatal", "invalid handshake was not fatal");
    assert(
      !(error instanceof HandshakeRejectedError),
      "invalid handshake was exposed as a typed rejection",
    );
    return;
  }
  const expected = resolveOptionalMessage(vector, responseStep, descriptor);
  if (expected !== undefined && record(expected, "handshake response").type === "rejected") {
    assert(error instanceof HandshakeRejectedError, "typed rejection was not preserved");
    const rejection = record(expected, "rejection");
    assert.equal(error.reason, rejection.reason);
    assert.equal(error.recovery, rejection.recovery);
    assert.deepEqual(error.protocol, rejection.protocol);
    assert.deepEqual(error.receivedProtocol, rejection.receivedProtocol);
    return;
  }
  assert(
    responseStep.close === true || responseStep.rawFrameHex !== undefined,
    `unexpected handshake failure: ${String(error)}`,
  );
}

async function loadStateVector(scenarioId: string): Promise<StateVector> {
  assert.match(scenarioId, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, "invalid scenario ID");
  const path = join(process.cwd(), "vectors", "state", `${scenarioId}.json`);
  const value = parseJSONObject(await readFile(path, "utf8"));
  assert.equal(typeof value.id, "string");
  assert.equal(typeof value.socketRunnable, "boolean");
  assert(Array.isArray(value.connections));
  return value as unknown as StateVector;
}

function parseArguments(arguments_: readonly string[]): {
  readonly descriptorPath: string;
  readonly scenarioId: string;
} {
  let descriptorPath: string | undefined;
  let scenarioId: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--descriptor") {
      descriptorPath = arguments_[index + 1];
      index += 1;
    } else if (argument === "--scenario") {
      scenarioId = arguments_[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument ?? "<missing>"}`);
    }
  }
  if (descriptorPath === undefined || scenarioId === undefined) {
    throw new Error("Expected --descriptor PATH and --scenario ID");
  }
  return { descriptorPath, scenarioId };
}

function requireHello(value: unknown): HelloFrame {
  const hello = record(value, "hello");
  assert.equal(hello.type, "hello");
  const client = record(hello.client, "hello.client");
  const hostCapabilities = record(
    hello.hostCapabilities,
    "hello.hostCapabilities",
  );
  assert(Array.isArray(hostCapabilities.interceptableSuggestionActionKeys));
  assert(Array.isArray(hello.capabilities));
  assert.equal(typeof hello.runId, "string");
  const frontend = hello.frontend === undefined
    ? undefined
    : record(hello.frontend, "hello.frontend");
  return {
    type: "hello",
    protocol: { major: 1, minor: 0 },
    client: {
      id: stringMember(client, "id"),
      version: stringMember(client, "version"),
      host: stringMember(client, "host"),
    },
    ...(frontend === undefined
      ? {}
      : { frontend: { id: stringMember(frontend, "id") } }),
    hostCapabilities: {
      interceptableSuggestionActionKeys:
        hostCapabilities.interceptableSuggestionActionKeys as SuggestionActionKey[],
    },
    runId: stringMember(hello, "runId"),
    launchToken: stringMember(hello, "launchToken"),
    capabilities: hello.capabilities as string[],
  };
}

function requireCommandEnvelope(value: unknown): ClientCommandEnvelope {
  const envelope = record(value, "client command envelope");
  assert.equal(envelope.type, "command");
  assert.equal(typeof envelope.sequence, "number");
  assert.equal(typeof envelope.id, "string");
  assert.equal(typeof envelope.command, "object");
  return envelope as unknown as ClientCommandEnvelope & { command: ClientCommand };
}

function resolveOptionalMessage(
  vector: StateVector,
  step: StateStep,
  descriptor: EndpointDescriptor,
): unknown | undefined {
  return step.message === undefined && step.messageRef === undefined
    ? undefined
    : substitute(resolveMessage(vector, step), descriptor);
}

function resolveMessage(vector: StateVector, step: StateStep): unknown {
  if (step.message !== undefined) {
    return step.message;
  }
  if (step.messageRef !== undefined) {
    assert(vector.messages, "messageRef used without a messages collection");
    assert(
      Object.hasOwn(vector.messages, step.messageRef),
      `unknown messageRef: ${step.messageRef}`,
    );
    return vector.messages[step.messageRef];
  }
  throw new Error("state step has no message");
}

function substitute(value: unknown, descriptor: EndpointDescriptor): unknown {
  if (typeof value === "string") {
    return value
      .replaceAll("${launchToken}", descriptor.launchToken)
      .replaceAll("${serverEpoch}", descriptor.serverEpoch);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substitute(item, descriptor));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substitute(item, descriptor)]),
    );
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as Record<string, unknown>;
}

function stringMember(value: Record<string, unknown>, key: string): string {
  assert.equal(typeof value[key], "string", `${key} must be a string`);
  return value[key] as string;
}
