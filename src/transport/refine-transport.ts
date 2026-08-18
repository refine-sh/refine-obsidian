import { randomUUID } from "node:crypto";

import type { PresentationInteraction } from "../integration/types";
import { abortReason } from "../shared/errors";
import { clearTimer, setTimer, type TimerHandle } from "../shared/timers";

import {
  EngineConnectionError,
  type EngineConnectionRecoverability,
} from "./engine-connection-error";
import {
  EndpointDescriptorError,
  EndpointProtocolVersionError,
  FileEndpointLocator,
  type EndpointLocator,
} from "./endpoint-locator";
import { MAX_FRAME_BYTES } from "./frame-codec";
import { isIntegerMember } from "./strict-json";
import { UnixFrameConnector } from "./unix-frame-connection";
import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  MAX_CAPABILITIES,
  MAX_SOURCE_BYTES,
  SUGGESTION_ACTION_KEYS,
  isActionUnavailableReason,
  isActionRejectionReason,
  isApplyRejectionReason,
  isApplyUnsupportedReason,
  isDiffRunKind,
  isFaultSeverityPair,
  isPresentationCoverage,
  isPresentationStatus,
  isPresentationUnavailableReason,
  isQuickApplyActivationStyle,
  isResyncReason,
  isSourceSyntax,
  isSuggestionActionKey,
  isSuggestionActionKind,
  isSuggestionHighlightStyle,
  isSuggestionKind,
  isTextDirection,
  type ClientCommand,
  type ClientCommandEnvelope,
  type HandshakeRejectedFrame,
  type HandshakeRecovery,
  type HelloFrame,
  type IntegrationClientIdentity,
  type PresentationContent,
  type ServerEventEnvelope,
  type WelcomeFrame,
} from "./wire";

const HANDSHAKE_TIMEOUT_MS = 5_000;

export interface FrameConnection {
  send(value: unknown): Promise<void>;
  receive(signal: AbortSignal): AsyncIterable<unknown>;
  close(): Promise<void>;
}

export interface FrameConnector {
  connect(path: string, signal: AbortSignal): Promise<FrameConnection>;
}

export interface RefineTransportOptions {
  readonly client: IntegrationClientIdentity;
  readonly frontend?: HelloFrame["frontend"];
  readonly hostCapabilities?: HelloFrame["hostCapabilities"];
  readonly capabilities?: readonly string[];
  readonly endpointLocator?: EndpointLocator;
  readonly connector?: FrameConnector;
}

export interface CommandReceipt {
  readonly sequence: number;
  readonly id: string;
}

export interface RefineTransportSession {
  readonly serverEpoch: string;
  readonly runResumed: boolean;
  readonly activatedCapabilities: readonly string[];
  send(command: ClientCommand, commandId?: string): Promise<CommandReceipt>;
  events(signal: AbortSignal): AsyncIterable<ServerEventEnvelope>;
  close(): Promise<void>;
}

export interface RefineConnectOptions {
  readonly runId?: string;
}

export class TransportProtocolError extends EngineConnectionError {
  constructor(
    message: string,
    recoverability: EngineConnectionRecoverability = "fatal",
    options?: ErrorOptions,
  ) {
    super(message, recoverability, options);
    this.name = "TransportProtocolError";
  }
}

export class EndpointReplacedError extends TransportProtocolError {
  constructor() {
    super("Refine server epoch changed during handshake", "recoverable");
    this.name = "EndpointReplacedError";
  }
}

export interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

export type HandshakeRejectionReason = HandshakeRejectedFrame["reason"];

export class HandshakeRejectedError extends TransportProtocolError {
  declare readonly receivedProtocol?: ProtocolVersion;

  constructor(
    readonly reason: HandshakeRejectionReason,
    readonly recovery: HandshakeRecovery,
    readonly protocol: ProtocolVersion,
    receivedProtocol?: ProtocolVersion,
    options?: ErrorOptions,
  ) {
    super(
      `Refine rejected the Integration Protocol connection: ${reason}/${recovery}`,
      recovery === "none" ? "fatal" : "recoverable",
      options,
    );
    if (receivedProtocol !== undefined) {
      this.receivedProtocol = receivedProtocol;
    }
    this.name = "HandshakeRejectedError";
  }
}

export class IncompatibleProtocolError extends HandshakeRejectedError {
  constructor(
    readonly serverProtocol: ProtocolVersion,
    readonly clientProtocol: ProtocolVersion = {
      major: PROTOCOL_MAJOR,
      minor: PROTOCOL_MINOR,
    },
    options?: ErrorOptions,
  ) {
    super(
      "incompatibleProtocol",
      "none",
      serverProtocol,
      clientProtocol,
      options,
    );
    this.message = `Refine reported Integration Protocol ${serverProtocol.major}.${serverProtocol.minor}; this client requires Integration Protocol ${clientProtocol.major}.${clientProtocol.minor}`;
    this.name = "IncompatibleProtocolError";
  }
}

export class RefineTransport {
  private readonly client: IntegrationClientIdentity;
  private readonly frontend: HelloFrame["frontend"] | undefined;
  private readonly hostCapabilities: HelloFrame["hostCapabilities"];
  private readonly offeredCapabilities: readonly string[];
  private readonly endpointLocator: EndpointLocator;
  private readonly connector: FrameConnector;

  constructor(options: RefineTransportOptions) {
    requireProtocolIdentifier(options.client.id, "client.id", TypeError);
    requireProtocolIdentifier(options.client.version, "client.version", TypeError);
    requireProtocolIdentifier(options.client.host, "client.host", TypeError);
    if (options.frontend !== undefined) {
      requireProtocolIdentifier(options.frontend.id, "frontend.id", TypeError);
    }
    this.client = options.client;
    this.frontend = options.frontend;
    this.hostCapabilities = validateHostCapabilities(
      options.hostCapabilities ?? {
        interceptableSuggestionActionKeys: SUGGESTION_ACTION_KEYS,
      },
    );
    this.offeredCapabilities = validateCapabilityOffers(options.capabilities ?? []);
    this.endpointLocator = options.endpointLocator ?? new FileEndpointLocator();
    this.connector = options.connector ?? new UnixFrameConnector();
  }

  async connect(
    signal: AbortSignal,
    options: RefineConnectOptions = {},
  ): Promise<RefineTransportSession> {
    const runId = options.runId ?? randomUUID();
    requireProtocolIdentifier(runId, "hello.runId", TypeError);
    let endpoint: Awaited<ReturnType<EndpointLocator["locate"]>>;
    try {
      endpoint = await this.endpointLocator.locate();
    } catch (error) {
      if (error instanceof EndpointProtocolVersionError) {
        throw new IncompatibleProtocolError(
          error.receivedProtocol,
          undefined,
          { cause: error },
        );
      }
      if (error instanceof EndpointDescriptorError) {
        throw new EngineConnectionError(
          "Refine endpoint metadata is invalid",
          "fatal",
          { cause: error },
        );
      }
      throw error;
    }
    const connection = await this.connector.connect(endpoint.socketPath, signal);
    const frames = connection.receive(signal)[Symbol.asyncIterator]();
    const hello: HelloFrame = {
      type: "hello",
      protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
      client: this.client,
      ...(this.frontend === undefined ? {} : { frontend: this.frontend }),
      hostCapabilities: this.hostCapabilities,
      runId,
      launchToken: endpoint.launchToken,
      capabilities: this.offeredCapabilities,
    };

    try {
      const first = await receiveHandshakeResponse(
        connection,
        frames,
        hello,
        signal,
      );
      if (signal.aborted) {
        throw abortReason(signal);
      }
      if (first.done) {
        throw new EngineConnectionError(
          "Refine closed the connection before welcome",
          "recoverable",
        );
      }
      const welcome = decodeHandshakeResponse(first.value, this.offeredCapabilities);
      if (welcome.serverEpoch !== endpoint.serverEpoch) {
        throw new EndpointReplacedError();
      }
      return new Session(
        connection,
        frames,
        welcome.serverEpoch,
        welcome.runResumed,
        welcome.capabilities,
      );
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }
}

function validateHostCapabilities(
  hostCapabilities: HelloFrame["hostCapabilities"],
): HelloFrame["hostCapabilities"] {
  const actionKeys = hostCapabilities.interceptableSuggestionActionKeys;
  if (new Set(actionKeys).size !== actionKeys.length) {
    throw new TypeError("Interceptable suggestion action keys must be duplicate-free");
  }
  if (actionKeys.some((key) => !isSuggestionActionKey(key))) {
    throw new TypeError("Interceptable suggestion action keys contain an unknown key");
  }
  return { interceptableSuggestionActionKeys: [...actionKeys] };
}

function validateCapabilityOffers(capabilities: readonly string[]): readonly string[] {
  if (capabilities.length > MAX_CAPABILITIES) {
    throw new RangeError(
      `Capability offers cannot contain more than ${MAX_CAPABILITIES} entries`,
    );
  }
  if (new Set(capabilities).size !== capabilities.length) {
    throw new TypeError("Capability offers must be duplicate-free");
  }
  if (capabilities.some((capability) => !isProtocolIdentifier(capability))) {
    throw new TypeError(
      "Capability identifiers must contain 1 to 128 visible ASCII bytes",
    );
  }
  return [...capabilities];
}

function isProtocolIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,128}$/.test(value);
}

function requireProtocolIdentifier(
  value: unknown,
  label: string,
  ErrorType: typeof TypeError | typeof TransportProtocolError =
    TransportProtocolError,
): asserts value is string {
  if (!isProtocolIdentifier(value)) {
    throw new ErrorType(
      `${label} must be a 1-to-128-byte visible ASCII identifier`,
    );
  }
}

async function receiveHandshakeResponse(
  connection: FrameConnection,
  frames: AsyncIterator<unknown>,
  hello: HelloFrame,
  signal: AbortSignal,
): Promise<IteratorResult<unknown>> {
  if (signal.aborted) {
    throw abortReason(signal);
  }

  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
  });
  let timeout: TimerHandle | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimer(() => {
      if (signal.aborted) {
        reject(abortReason(signal));
      } else {
        reject(new EngineConnectionError(
          "Timed out waiting for Refine welcome",
          "recoverable",
        ));
      }
    }, HANDSHAKE_TIMEOUT_MS);
  });
  const response = (async (): Promise<IteratorResult<unknown>> => {
    await connection.send(hello);
    const first = await frames.next();
    if (signal.aborted) {
      throw abortReason(signal);
    }
    return first;
  })();

  try {
    return await Promise.race([response, aborted, timedOut]);
  } catch (error) {
    if (signal.aborted) {
      throw abortReason(signal);
    }
    throw error;
  } finally {
    clearTimer(timeout);
    if (abort !== undefined) {
      signal.removeEventListener("abort", abort);
    }
  }
}

class Session implements RefineTransportSession {
  private commandSequence = 0;
  private readonly commandIds = new Set<string>();
  private expectedEventSequence = 1;
  private eventsClaimed = false;
  private closed = false;
  private sendTail = Promise.resolve();

  constructor(
    private readonly connection: FrameConnection,
    private readonly frames: AsyncIterator<unknown>,
    readonly serverEpoch: string,
    readonly runResumed: boolean,
    readonly activatedCapabilities: readonly string[],
  ) {}

  async send(command: ClientCommand, commandId?: string): Promise<CommandReceipt> {
    const operation = this.sendTail.then(async (): Promise<CommandReceipt> => {
      if (this.closed) {
        throw new Error("Refine transport session is closed");
      }
      const id = commandId ?? randomUUID();
      validateOutboundCommand(command, id);
      if (this.commandIds.has(id)) {
        throw new TransportProtocolError(
          "Client command ID must be unique within a session",
        );
      }
      if (this.commandSequence >= 0xffff_ffff) {
        throw new TransportProtocolError("Client command sequence exhausted");
      }
      const sequence = this.commandSequence + 1;
      const envelope: ClientCommandEnvelope = { type: "command", sequence, id, command };
      await this.connection.send(envelope);
      this.commandSequence = sequence;
      this.commandIds.add(id);
      if (sequence === 0xffff_ffff) {
        this.closed = true;
        await this.connection.close();
      }
      return { sequence, id };
    });
    this.sendTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async *events(signal: AbortSignal): AsyncIterable<ServerEventEnvelope> {
    if (this.eventsClaimed) {
      throw new Error("Refine transport events can only be observed once");
    }
    this.eventsClaimed = true;
    while (!signal.aborted && !this.closed) {
      const next = await this.frames.next();
      if (next.done) {
        return;
      }
      const envelope = decodeEventEnvelope(next.value);
      if (envelope.epoch !== this.serverEpoch) {
        throw new TransportProtocolError("Received an event from a different server epoch");
      }
      if (envelope.sequence !== this.expectedEventSequence) {
        throw new TransportProtocolError(
          `Expected server event sequence ${this.expectedEventSequence}, received ${envelope.sequence}`,
        );
      }
      if (envelope.sequence === 0xffff_ffff) {
        this.closed = true;
        await this.connection.close();
        yield envelope;
        return;
      }
      this.expectedEventSequence += 1;
      yield envelope;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.connection.close();
  }
}

function validateOutboundCommand(command: ClientCommand, commandId: string): void {
  requireProtocolIdentifier(commandId, "command.id");
  const object = requireRecord(command, "Client command");
  switch (object.type) {
    case "openDocument":
    case "replaceDocument":
      validateOutboundSnapshot(object.snapshot, "snapshot");
      return;
    case "updateAttention": {
      requireProtocolIdentifier(object.revision, "updateAttention.revision");
      const attention = requireRecord(
        object.attention,
        "updateAttention.attention",
      );
      requireProtocolIdentifier(
        attention.sourceId,
        "updateAttention.attention.sourceId",
      );
      if (
        attention.caretOffset !== undefined &&
        !isSafeUnsignedInteger(attention.caretOffset)
      ) {
        throw new TransportProtocolError(
          "updateAttention.attention.caretOffset must be a nonnegative safe integer",
        );
      }
      validateVisibleRanges(attention.visibleRanges);
      return;
    }
    case "requestCheck": {
      requireProtocolIdentifier(object.revision, "requestCheck.revision");
      if (object.intent === undefined) {
        return;
      }
      const intent = requireRecord(object.intent, "requestCheck.intent");
      if (intent.forcedLanguageTag !== undefined) {
        requireProtocolIdentifier(
          intent.forcedLanguageTag,
          "requestCheck.intent.forcedLanguageTag",
        );
      }
      if (intent.sourceIds !== undefined) {
        if (!Array.isArray(intent.sourceIds) || intent.sourceIds.length < 1 || intent.sourceIds.length > 2) {
          throw new TransportProtocolError(
            "requestCheck.intent.sourceIds must contain between one and two source IDs",
          );
        }
        requireUniqueProtocolIdentifiers(
          intent.sourceIds as string[],
          "requestCheck.intent.sourceIds",
        );
      }
      if (intent.selection !== undefined) {
        if (intent.sourceIds !== undefined) {
          throw new TransportProtocolError(
            "requestCheck.intent cannot contain both sourceIds and selection",
          );
        }
        const selection = requireRecord(
          intent.selection,
          "requestCheck.intent.selection",
        );
        requireProtocolIdentifier(
          selection.sourceId,
          "requestCheck.intent.selection.sourceId",
        );
        validateOutboundRange(
          selection.range,
          "requestCheck.intent.selection.range",
          true,
        );
      }
      return;
    }
    case "performAction": {
      requireProtocolIdentifier(object.actionId, "performAction.actionId");
      if (!isSuggestionActionKind(object.kind)) {
        throw new TransportProtocolError("Unknown performAction.kind");
      }
      const suggestion = requireRecord(
        object.suggestion,
        "performAction.suggestion",
      );
      requireProtocolIdentifier(
        suggestion.id,
        "performAction.suggestion.id",
      );
      requireProtocolIdentifier(
        suggestion.documentRevision,
        "performAction.suggestion.documentRevision",
      );
      return;
    }
    case "completeApply": {
      requireProtocolIdentifier(
        object.transactionId,
        "completeApply.transactionId",
      );
      validateOutboundApplyOutcome(object.outcome);
      return;
    }
    case "closeDocument":
      return;
    default:
      throw new TransportProtocolError("Unknown client command type");
  }
}

function validateOutboundSnapshot(
  value: unknown,
  label: string,
): void {
  const snapshot = requireRecord(value, label);
  requireProtocolIdentifier(snapshot.revision, `${label}.revision`);
  if (!Array.isArray(snapshot.sources) || snapshot.sources.length < 1 || snapshot.sources.length > 2) {
    throw new TransportProtocolError(
      `${label}.sources must contain between one and two sources`,
    );
  }
  const sourceIds: string[] = [];
  snapshot.sources.forEach((value, index) => {
    const source = requireRecord(value, `${label}.sources[${index}]`);
    requireProtocolIdentifier(
      source.sourceId,
      `${label}.sources[${index}].sourceId`,
    );
    if (typeof source.text !== "string") {
      throw new TransportProtocolError(
        `${label}.sources[${index}].text must be a string`,
      );
    }
    if (!isSourceSyntax(source.sourceSyntax)) {
      throw new TransportProtocolError(
        `${label}.sources[${index}].sourceSyntax is unknown`,
      );
    }
    if (Buffer.byteLength(source.text, "utf8") > MAX_SOURCE_BYTES) {
      throw new TransportProtocolError(
        `Source text must be at most ${MAX_SOURCE_BYTES} UTF-8 bytes`,
      );
    }
    sourceIds.push(source.sourceId);
  });
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new TransportProtocolError(
      `${label} source IDs must be duplicate-free`,
    );
  }
}

function validateVisibleRanges(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new TransportProtocolError(
      "updateAttention.attention.visibleRanges must be an array",
    );
  }
  let priorEnd: number | undefined;
  value.forEach((range, index) => {
    const decoded = validateOutboundRange(
      range,
      `updateAttention.attention.visibleRanges[${index}]`,
      true,
    );
    if (priorEnd !== undefined && decoded.location < priorEnd) {
      throw new TransportProtocolError(
        "Visible ranges must be ordered and nonoverlapping",
      );
    }
    priorEnd = decoded.location + decoded.length;
  });
}

function validateOutboundRange(
  value: unknown,
  label: string,
  nonempty: boolean,
): { readonly location: number; readonly length: number } {
  const range = requireRecord(value, label);
  if (
    !isSafeUnsignedInteger(range.location) ||
    !isSafeUnsignedInteger(range.length) ||
    (nonempty && range.length === 0) ||
    range.location + range.length > Number.MAX_SAFE_INTEGER
  ) {
    throw new TransportProtocolError(
      `${label} must be a representable${nonempty ? " nonempty" : ""} UTF-16 range`,
    );
  }
  return { location: range.location, length: range.length };
}

function validateOutboundApplyOutcome(value: unknown): void {
  const outcome = requireRecord(value, "completeApply.outcome");
  const validateOptionalSnapshot = (): void => {
    if (outcome.snapshot !== undefined) {
      validateOutboundSnapshot(
        outcome.snapshot,
        "completeApply.outcome.snapshot",
      );
    }
  };
  switch (outcome.status) {
    case "applied":
      if (Object.hasOwn(outcome, "reason")) {
        throw new TransportProtocolError(
          "Applied completeApply outcome cannot contain a reason",
        );
      }
      validateOutboundSnapshot(
        outcome.snapshot,
        "completeApply.outcome.snapshot",
      );
      return;
    case "rejected":
      if (!isApplyRejectionReason(outcome.reason)) {
        throw new TransportProtocolError("Unknown completeApply rejection reason");
      }
      validateOutboundSnapshot(
        outcome.snapshot,
        "completeApply.outcome.snapshot",
      );
      return;
    case "unsupported":
      if (!isApplyUnsupportedReason(outcome.reason)) {
        throw new TransportProtocolError("Unknown completeApply unsupported reason");
      }
      validateOptionalSnapshot();
      return;
    case "unavailable":
    case "indeterminate":
      if (Object.hasOwn(outcome, "reason")) {
        throw new TransportProtocolError(
          `${outcome.status} completeApply outcome cannot contain a reason`,
        );
      }
      validateOptionalSnapshot();
      return;
    default:
      throw new TransportProtocolError("Unknown completeApply outcome status");
  }
}

function requireUniqueProtocolIdentifiers(
  values: readonly string[],
  label: string,
): void {
  values.forEach((value, index) => {
    requireProtocolIdentifier(value, `${label}[${index}]`);
  });
  if (new Set(values).size !== values.length) {
    throw new TransportProtocolError(`${label} must be duplicate-free`);
  }
}

function decodeHandshakeResponse(
  value: unknown,
  offeredCapabilities: readonly string[],
): WelcomeFrame {
  const object = requireRecord(value, "handshake response");
  if (object.type === "rejected") {
    const rejection = decodeHandshakeRejection(object);
    if (rejection.reason === "incompatibleProtocol") {
      throw new IncompatibleProtocolError(
        rejection.protocol,
        rejection.receivedProtocol,
      );
    }
    throw new HandshakeRejectedError(
      rejection.reason,
      rejection.recovery,
      rejection.protocol,
    );
  }
  return decodeWelcome(object, offeredCapabilities);
}

function decodeHandshakeRejection(
  object: Record<string, unknown>,
): HandshakeRejectedFrame {
  const protocol = requireRecord(object.protocol, "rejected.protocol");
  if (
    object.type !== "rejected" ||
    !isUInt16(protocol.major) ||
    !isIntegerMember(protocol, "major", 0, 0xffff) ||
    !isUInt16(protocol.minor) ||
    !isIntegerMember(protocol, "minor", 0, 0xffff) ||
    protocol.major !== PROTOCOL_MAJOR ||
    protocol.minor !== PROTOCOL_MINOR
  ) {
    throw new TransportProtocolError("Malformed handshake rejection");
  }
  const exactProtocol = {
    major: PROTOCOL_MAJOR,
    minor: PROTOCOL_MINOR,
  } as const;
  if (object.reason === "incompatibleProtocol" && object.recovery === "none") {
    const received = requireRecord(
      object.receivedProtocol,
      "rejected.receivedProtocol",
    );
    if (
      !isUInt16(received.major) ||
      !isIntegerMember(received, "major", 0, 0xffff) ||
      !isUInt16(received.minor) ||
      !isIntegerMember(received, "minor", 0, 0xffff)
    ) {
      throw new TransportProtocolError("Malformed handshake rejection");
    }
    return {
      type: "rejected",
      reason: "incompatibleProtocol",
      recovery: "none",
      protocol: exactProtocol,
      receivedProtocol: { major: received.major, minor: received.minor },
    };
  }
  if ("receivedProtocol" in object) {
    throw new TransportProtocolError("Malformed handshake rejection");
  }
  if (object.reason === "invalidClient" && object.recovery === "none") {
    return {
      type: "rejected",
      reason: "invalidClient",
      recovery: "none",
      protocol: exactProtocol,
    };
  }
  if (
    object.reason === "runUnavailable" &&
    (object.recovery === "newRun" || object.recovery === "retry")
  ) {
    return {
      type: "rejected",
      reason: "runUnavailable",
      recovery: object.recovery,
      protocol: exactProtocol,
    };
  }
  if (
    (object.reason === "serverBusy" || object.reason === "engineUnavailable") &&
    object.recovery === "retry"
  ) {
    return {
      type: "rejected",
      reason: object.reason,
      recovery: "retry",
      protocol: exactProtocol,
    };
  }
  throw new TransportProtocolError("Malformed handshake rejection");
}

function decodeWelcome(
  value: unknown,
  offeredCapabilities: readonly string[],
): WelcomeFrame {
  const object = requireRecord(value, "welcome");
  const protocol = requireRecord(object.protocol, "welcome.protocol");
  const limits = requireRecord(object.limits, "welcome.limits");
  const serverEpoch = object.serverEpoch;
  requireProtocolIdentifier(serverEpoch, "welcome.serverEpoch");
  if (
    !isUInt16(protocol.major) ||
    !isIntegerMember(protocol, "major", 0, 0xffff) ||
    !isUInt16(protocol.minor) ||
    !isIntegerMember(protocol, "minor", 0, 0xffff)
  ) {
    throw new TransportProtocolError("Malformed welcome protocol version");
  }
  if (protocol.major !== PROTOCOL_MAJOR || protocol.minor !== PROTOCOL_MINOR) {
    throw new IncompatibleProtocolError(
      {
        major: protocol.major,
        minor: protocol.minor,
      },
    );
  }
  if (
    object.type !== "welcome" ||
    typeof object.runResumed !== "boolean" ||
    limits.maxFrameBytes !== MAX_FRAME_BYTES ||
    !isIntegerMember(limits, "maxFrameBytes", MAX_FRAME_BYTES, MAX_FRAME_BYTES) ||
    limits.maxSources !== 2 ||
    !isIntegerMember(limits, "maxSources", 2, 2) ||
    limits.maxSourceBytes !== MAX_SOURCE_BYTES ||
    !isIntegerMember(limits, "maxSourceBytes", MAX_SOURCE_BYTES, MAX_SOURCE_BYTES) ||
    !isStringArray(object.capabilities)
  ) {
    throw new TransportProtocolError("Malformed or incompatible welcome frame");
  }
  if (object.capabilities.length > MAX_CAPABILITIES) {
    throw new TransportProtocolError(
      `Capability activations cannot contain more than ${MAX_CAPABILITIES} entries`,
    );
  }
  if (new Set(object.capabilities).size !== object.capabilities.length) {
    throw new TransportProtocolError("Capability activations must be duplicate-free");
  }
  if (object.capabilities.some((capability) => !isProtocolIdentifier(capability))) {
    throw new TransportProtocolError("Malformed capability activation identifier");
  }
  const offered = new Set(offeredCapabilities);
  if (object.capabilities.some((capability) => !offered.has(capability))) {
    throw new TransportProtocolError("Server activated an unsupported capability");
  }
  return {
    type: "welcome",
    protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
    serverEpoch,
    runResumed: object.runResumed,
    limits: {
      maxFrameBytes: MAX_FRAME_BYTES,
      maxSources: 2,
      maxSourceBytes: MAX_SOURCE_BYTES,
    },
    capabilities: [...object.capabilities],
  };
}

function decodeEventEnvelope(value: unknown): ServerEventEnvelope {
  const object = requireRecord(value, "event envelope");
  const epoch = object.epoch;
  requireProtocolIdentifier(epoch, "event.epoch");
  if (object.causeCommandId !== undefined) {
    requireProtocolIdentifier(object.causeCommandId, "event.causeCommandId");
  }
  if (
    object.type !== "event" ||
    !isUInt32(object.sequence) ||
    !isIntegerMember(object, "sequence", 1, 0xffff_ffff) ||
    object.sequence === 0
  ) {
    throw new TransportProtocolError("Malformed server event envelope");
  }
  const event = decodeServerEvent(object.event);
  return object.causeCommandId === undefined
    ? { type: "event", sequence: object.sequence, epoch, event }
    : {
        type: "event",
        sequence: object.sequence,
        epoch,
        causeCommandId: object.causeCommandId,
        event,
      };
}

function decodeServerEvent(value: unknown): ServerEventEnvelope["event"] {
  const event = requireRecord(value, "server event");
  switch (event.type) {
    case "documentAccepted":
      requireProtocolIdentifier(event.revision, "documentAccepted.revision");
      return { type: "documentAccepted", revision: event.revision };
    case "resyncRequired":
      if (!isResyncReason(event.reason)) {
        throw new TransportProtocolError("Malformed resyncRequired.reason");
      }
      return { type: "resyncRequired", reason: event.reason };
    case "presentationContentReplaced":
      requireProtocolIdentifier(event.checkId, "presentationContentReplaced.checkId");
      return {
        type: "presentationContentReplaced",
        checkId: event.checkId,
        content: decodePresentationContent(event.content),
      };
    case "applyRequested":
      requireProtocolIdentifier(event.actionId, "applyRequested.actionId");
      requireProtocolIdentifier(event.transactionId, "applyRequested.transactionId");
      return {
        type: "applyRequested",
        actionId: event.actionId,
        transactionId: event.transactionId,
        request: decodeApplyRequest(event.request),
      };
    case "explanationReplaced":
      requireProtocolIdentifier(event.actionId, "explanationReplaced.actionId");
      return {
        type: "explanationReplaced",
        actionId: event.actionId,
        update: decodeExplanationUpdate(event.update),
      };
    case "actionCompleted":
      requireProtocolIdentifier(event.actionId, "actionCompleted.actionId");
      return { type: "actionCompleted", actionId: event.actionId };
    case "actionRejected":
      requireProtocolIdentifier(event.actionId, "actionRejected.actionId");
      if (!isActionRejectionReason(event.reason)) {
        throw new TransportProtocolError("Malformed actionRejected.reason");
      }
      return { type: "actionRejected", actionId: event.actionId, reason: event.reason };
    case "fault":
      if (!isFaultSeverityPair(event.code, event.fatal)) {
        throw new TransportProtocolError("Malformed fault severity pair");
      }
      return {
        type: "fault",
        code: event.code,
        fatal: event.fatal,
      } as Extract<ServerEventEnvelope["event"], { readonly type: "fault" }>;
    default:
      throw new TransportProtocolError("Unknown server event type");
  }
}

function decodePresentationContent(value: unknown): PresentationContent {
  const content = requireRecord(value, "presentation content");
  requireProtocolIdentifier(content.documentRevision, "presentation.documentRevision");
  if (!isPresentationStatus(content.status) || !Array.isArray(content.suggestions)) {
    throw new TransportProtocolError("Malformed presentation content");
  }
  const hasCoverage = Object.hasOwn(content, "coverage");
  const hasUnavailableReason = Object.hasOwn(content, "unavailableReason");
  const hasProgress = Object.hasOwn(content, "progress");
  const coverage = isPresentationCoverage(content.coverage)
    ? content.coverage
    : undefined;
  const unavailableReason = isPresentationUnavailableReason(
    content.unavailableReason,
  )
    ? content.unavailableReason
    : undefined;
  switch (content.status) {
    case "pending":
      if (
        content.suggestions.length !== 0 ||
        hasCoverage ||
        hasUnavailableReason ||
        hasProgress
      ) {
        throw new TransportProtocolError("Malformed pending presentation branch");
      }
      break;
    case "checking":
      if (hasCoverage || hasUnavailableReason) {
        throw new TransportProtocolError("Malformed checking presentation branch");
      }
      break;
    case "complete":
      if (
        !hasCoverage ||
        coverage === undefined ||
        hasUnavailableReason ||
        hasProgress
      ) {
        throw new TransportProtocolError("Malformed complete presentation branch");
      }
      break;
    case "unavailable":
      if (
        content.suggestions.length !== 0 ||
        hasCoverage ||
        !hasUnavailableReason ||
        unavailableReason === undefined ||
        hasProgress
      ) {
        throw new TransportProtocolError("Malformed unavailable presentation branch");
      }
      break;
    case "closed":
      if (
        content.suggestions.length !== 0 ||
        hasCoverage ||
        hasUnavailableReason ||
        hasProgress
      ) {
        throw new TransportProtocolError("Malformed closed presentation branch");
      }
      break;
  }
  const suggestions = content.suggestions.map(decodePresentedSuggestion);
  const appearance = decodePresentationAppearance(content.appearance);
  const interaction = decodePresentationInteraction(content.interaction);
  const progress = !hasProgress
    ? undefined
    : decodeCheckingProgress(content.progress);
  if (content.status === "complete") {
    if (coverage === undefined) {
      throw new TransportProtocolError("Malformed complete presentation branch");
    }
    return {
      documentRevision: content.documentRevision,
      status: "complete",
      coverage,
      appearance,
      interaction,
      suggestions,
    };
  }
  if (content.status === "unavailable") {
    if (unavailableReason === undefined) {
      throw new TransportProtocolError("Malformed unavailable presentation branch");
    }
    return {
      documentRevision: content.documentRevision,
      status: "unavailable",
      unavailableReason,
      appearance,
      interaction,
      suggestions,
    };
  }
  if (content.status === "checking" && progress !== undefined) {
    return {
      documentRevision: content.documentRevision,
      status: "checking",
      progress,
      appearance,
      interaction,
      suggestions,
    };
  }
  return {
    documentRevision: content.documentRevision,
    status: content.status,
    appearance,
    interaction,
    suggestions,
  };
}

function decodeCheckingProgress(
  value: unknown,
): import("../integration/types").CheckingProgress {
  const progress = requireRecord(value, "presentation.progress");
  const completedUnitCount = progress.completedUnitCount;
  const totalUnitCount = progress.totalUnitCount;
  if (
    typeof completedUnitCount !== "number" ||
    typeof totalUnitCount !== "number" ||
    !Number.isSafeInteger(completedUnitCount) ||
    !Number.isSafeInteger(totalUnitCount) ||
    !isIntegerMember(progress, "completedUnitCount", 0) ||
    !isIntegerMember(progress, "totalUnitCount", 0) ||
    completedUnitCount < 0 ||
    totalUnitCount < 0 ||
    completedUnitCount > totalUnitCount
  ) {
    throw new TransportProtocolError("Malformed presentation progress");
  }
  return {
    completedUnitCount,
    totalUnitCount,
  };
}

function decodePresentationAppearance(
  value: unknown,
): import("../integration/types").PresentationAppearance {
  const appearance = requireRecord(value, "presentation.appearance");
  const highlight = requireRecord(appearance.highlight, "presentation.appearance.highlight");
  const diff = requireRecord(appearance.diff, "presentation.appearance.diff");
  if (
    !isSuggestionHighlightStyle(highlight.style) ||
    !isCanonicalRGBColor(highlight.grammarColor) ||
    !isCanonicalRGBColor(highlight.fluencyColor) ||
    !isCanonicalRGBColor(diff.additionColor) ||
    !isCanonicalRGBColor(diff.deletionColor) ||
    typeof diff.showHiddenWhitespace !== "boolean"
  ) {
    throw new TransportProtocolError("Malformed presentation appearance");
  }
  return {
    highlight: {
      style: highlight.style,
      grammarColor: highlight.grammarColor,
      fluencyColor: highlight.fluencyColor,
    },
    diff: {
      additionColor: diff.additionColor,
      deletionColor: diff.deletionColor,
      showHiddenWhitespace: diff.showHiddenWhitespace,
    },
  };
}

function decodePresentationInteraction(value: unknown): PresentationInteraction {
  const interaction = requireRecord(value, "presentation.interaction");
  const quickApply = requireRecord(
    interaction.quickApply,
    "presentation.interaction.quickApply",
  );
  if (
    typeof interaction.automaticChecksEnabled !== "boolean" ||
    typeof quickApply.enabled !== "boolean" ||
    !isSuggestionActionKey(quickApply.applyKey) ||
    !isSuggestionActionKey(quickApply.dismissKey) ||
    !isQuickApplyActivationStyle(quickApply.activationStyle)
  ) {
    throw new TransportProtocolError("Malformed presentation interaction");
  }
  return {
    automaticChecksEnabled: interaction.automaticChecksEnabled,
    quickApply: {
      enabled: quickApply.enabled,
      applyKey: quickApply.applyKey,
      dismissKey: quickApply.dismissKey,
      activationStyle: quickApply.activationStyle,
    },
  };
}

function isCanonicalRGBColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9A-F]{6}$/.test(value);
}

function decodePresentedSuggestion(
  value: unknown,
): import("../integration/types").PresentedSuggestion {
  const suggestion = requireRecord(value, "presented suggestion");
  requireProtocolIdentifier(suggestion.id, "suggestion.id");
  requireProtocolIdentifier(suggestion.sourceId, "suggestion.sourceId");
  if (!isSuggestionKind(suggestion.kind)) {
    throw new TransportProtocolError("Malformed suggestion kind");
  }
  if (
    !Array.isArray(suggestion.highlightRanges) ||
    !Array.isArray(suggestion.diff) ||
    !Array.isArray(suggestion.availableActions)
  ) {
    throw new TransportProtocolError("Malformed presented suggestion");
  }
  const attribution = requireRecord(
    suggestion.attribution,
    "suggestion.attribution",
  );
  if (
    typeof attribution.languageDisplayName !== "string" ||
    attribution.languageDisplayName.length === 0 ||
    !isTextDirection(attribution.textDirection) ||
    typeof attribution.checkModelDisplayName !== "string" ||
    attribution.checkModelDisplayName.length === 0
  ) {
    throw new TransportProtocolError("Malformed suggestion attribution");
  }
  const availableActions = suggestion.availableActions.map((action) => {
    if (!isSuggestionActionKind(action)) {
      throw new TransportProtocolError("Malformed suggestion action");
    }
    return action;
  });
  if (new Set(availableActions).size !== availableActions.length) {
    throw new TransportProtocolError(
      "Suggestion available actions must be duplicate-free",
    );
  }
  return {
    id: suggestion.id,
    sourceId: suggestion.sourceId,
    kind: suggestion.kind,
    attribution: {
      languageDisplayName: attribution.languageDisplayName,
      textDirection: attribution.textDirection,
      checkModelDisplayName: attribution.checkModelDisplayName,
    },
    activationRange: decodeExactRange(
      suggestion.activationRange,
      "suggestion.activationRange",
    ),
    highlightRanges: suggestion.highlightRanges.map(decodeRange),
    diff: suggestion.diff.map((run) => {
      const object = requireRecord(run, "diff run");
      if (
        !isDiffRunKind(object.kind) ||
        typeof object.text !== "string"
      ) {
        throw new TransportProtocolError("Malformed diff run");
      }
      return { kind: object.kind, text: object.text };
    }),
    availableActions,
  };
}

function decodeExactRange(
  value: unknown,
  label: string,
): import("../integration/types").UTF16Range {
  const range = requireRecord(value, label);
  return decodeRange(range);
}

function decodeApplyRequest(value: unknown): import("../integration/types").HostApplyRequest {
  const request = requireRecord(value, "apply request");
  requireProtocolIdentifier(request.expectedRevision, "apply.expectedRevision");
  requireProtocolIdentifier(request.sourceId, "apply.sourceId");
  if (!Array.isArray(request.edits) || request.edits.length === 0) {
    throw new TransportProtocolError("Apply request requires edits");
  }
  const edits = request.edits.map((edit) => {
    const object = requireRecord(edit, "host edit");
    if (typeof object.expectedText !== "string" || typeof object.replacement !== "string") {
      throw new TransportProtocolError("Malformed host edit");
    }
    return {
      range: decodeRange(object.range),
      expectedText: object.expectedText,
      replacement: object.replacement,
    };
  });
  let priorLocation: number | undefined;
  for (const edit of edits) {
    const { location, length } = edit.range;
    if (
      edit.expectedText === edit.replacement ||
      (priorLocation !== undefined &&
        (location >= priorLocation || location + length > priorLocation))
    ) {
      throw new TransportProtocolError(
        "Apply request edits must be descending without ties, overlaps, or no-ops",
      );
    }
    priorLocation = location;
  }
  return {
    expectedRevision: request.expectedRevision,
    sourceId: request.sourceId,
    edits,
  };
}

function decodeRange(value: unknown): import("../integration/types").UTF16Range {
  const range = requireRecord(value, "UTF-16 range");
  if (
    !Number.isSafeInteger(range.location) ||
    !isIntegerMember(range, "location", 0) ||
    !Number.isSafeInteger(range.length) ||
    !isIntegerMember(range, "length", 0)
  ) {
    throw new TransportProtocolError("Range coordinates must be integers");
  }
  const location = range.location as number;
  const length = range.length as number;
  if (
    location < 0 ||
    length < 0 ||
    location > Number.MAX_SAFE_INTEGER - length
  ) {
    throw new TransportProtocolError(
      "Range coordinates must form a representable nonnegative endpoint",
    );
  }
  return { location, length };
}

function decodeExplanationUpdate(
  value: unknown,
): import("../integration/types").ExplanationUpdate {
  const update = requireRecord(value, "explanation update");
  if (update.status === "started") {
    const attribution = requireRecord(
      update.attribution,
      "explanation attribution",
    );
    if (
      typeof attribution.languageDisplayName !== "string" ||
      attribution.languageDisplayName.length === 0 ||
      !isTextDirection(attribution.textDirection) ||
      typeof attribution.modelDisplayName !== "string" ||
      attribution.modelDisplayName.length === 0
    ) {
      throw new TransportProtocolError("Malformed explanation attribution");
    }
    return {
      status: "started",
      attribution: {
        languageDisplayName: attribution.languageDisplayName,
        textDirection: attribution.textDirection,
        modelDisplayName: attribution.modelDisplayName,
      },
    };
  }
  if (update.status === "streaming" || update.status === "completed") {
    if (typeof update.text !== "string") {
      throw new TransportProtocolError("Explanation text must be a string");
    }
    return { status: update.status, text: update.text };
  }
  if (update.status === "stale") {
    return { status: "stale" };
  }
  if (update.status === "unavailable" && isActionUnavailableReason(update.reason)) {
    return {
      status: "unavailable",
      reason: update.reason,
    };
  }
  throw new TransportProtocolError("Malformed explanation update");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TransportProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isUInt32(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
}

function isUInt16(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff;
}

function isSafeUnsignedInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
