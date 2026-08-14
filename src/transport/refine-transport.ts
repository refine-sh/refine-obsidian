import { randomUUID } from "node:crypto";

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
import { UnixFrameConnector } from "./unix-frame-connection";
import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  isActionRejectionReason,
  type ClientCommand,
  type ClientCommandEnvelope,
  type HelloFrame,
  type IntegrationClientIdentity,
  type PresentationContent,
  type ServerEventEnvelope,
  type WelcomeFrame,
} from "./wire";

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

export class IncompatibleProtocolError extends TransportProtocolError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "fatal", options);
    this.name = "IncompatibleProtocolError";
  }
}

export class RefineTransport {
  private readonly client: IntegrationClientIdentity;
  private readonly endpointLocator: EndpointLocator;
  private readonly connector: FrameConnector;

  constructor(options: RefineTransportOptions) {
    this.client = options.client;
    this.endpointLocator = options.endpointLocator ?? new FileEndpointLocator();
    this.connector = options.connector ?? new UnixFrameConnector();
  }

  async connect(
    signal: AbortSignal,
    options: RefineConnectOptions = {},
  ): Promise<RefineTransportSession> {
    let endpoint: Awaited<ReturnType<EndpointLocator["locate"]>>;
    try {
      endpoint = await this.endpointLocator.locate();
    } catch (error) {
      if (error instanceof EndpointProtocolVersionError) {
        throw new IncompatibleProtocolError(error.message, { cause: error });
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
      runId: options.runId ?? randomUUID(),
      launchToken: endpoint.launchToken,
      capabilities: [],
    };

    try {
      await connection.send(hello);
      const first = await frames.next();
      if (first.done) {
        throw new TransportProtocolError("Refine closed the connection before welcome");
      }
      const welcome = decodeWelcome(first.value);
      if (welcome.serverEpoch !== endpoint.serverEpoch) {
        throw new EndpointReplacedError();
      }
      return new Session(
        connection,
        frames,
        welcome.serverEpoch,
        welcome.runResumed,
      );
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }
}

class Session implements RefineTransportSession {
  private commandSequence = 0;
  private expectedEventSequence = 1;
  private eventsClaimed = false;
  private closed = false;
  private sendTail = Promise.resolve();

  constructor(
    private readonly connection: FrameConnection,
    private readonly frames: AsyncIterator<unknown>,
    readonly serverEpoch: string,
    readonly runResumed: boolean,
  ) {}

  async send(command: ClientCommand, commandId?: string): Promise<CommandReceipt> {
    const operation = this.sendTail.then(async (): Promise<CommandReceipt> => {
      if (this.closed) {
        throw new Error("Refine transport session is closed");
      }
      if (this.commandSequence >= 0xffff_ffff) {
        throw new TransportProtocolError("Client command sequence exhausted");
      }
      const sequence = this.commandSequence + 1;
      const id = commandId ?? randomUUID();
      const envelope: ClientCommandEnvelope = { type: "command", sequence, id, command };
      await this.connection.send(envelope);
      this.commandSequence = sequence;
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

function decodeWelcome(value: unknown): WelcomeFrame {
  const object = requireRecord(value, "welcome");
  const protocol = requireRecord(object.protocol, "welcome.protocol");
  const limits = requireRecord(object.limits, "welcome.limits");
  if (!isUInt32(protocol.major) || !isUInt32(protocol.minor)) {
    throw new TransportProtocolError("Malformed welcome protocol version");
  }
  if (protocol.major !== PROTOCOL_MAJOR || protocol.minor !== PROTOCOL_MINOR) {
    throw new IncompatibleProtocolError(
      `Refine protocol ${protocol.major}.${protocol.minor} is incompatible with protocol ${PROTOCOL_MAJOR}.${PROTOCOL_MINOR}`,
    );
  }
  if (
    object.type !== "welcome" ||
    typeof object.serverEpoch !== "string" ||
    object.serverEpoch.length === 0 ||
    typeof object.runResumed !== "boolean" ||
    limits.maxFrameBytes !== 4_194_304 ||
    limits.maxSources !== 2 ||
    !isStringArray(object.capabilities)
  ) {
    throw new TransportProtocolError("Malformed or incompatible welcome frame");
  }
  return {
    type: "welcome",
    protocol: { major: 2, minor: 1 },
    serverEpoch: object.serverEpoch,
    runResumed: object.runResumed,
    limits: { maxFrameBytes: 4_194_304, maxSources: 2 },
    capabilities: object.capabilities,
  };
}

function decodeEventEnvelope(value: unknown): ServerEventEnvelope {
  const object = requireRecord(value, "event envelope");
  if (
    object.type !== "event" ||
    !isUInt32(object.sequence) ||
    object.sequence === 0 ||
    typeof object.epoch !== "string" ||
    object.epoch.length === 0 ||
    (object.causeCommandId !== undefined && typeof object.causeCommandId !== "string")
  ) {
    throw new TransportProtocolError("Malformed server event envelope");
  }
  const event = decodeServerEvent(object.event);
  return object.causeCommandId === undefined
    ? { type: "event", sequence: object.sequence, epoch: object.epoch, event }
    : {
        type: "event",
        sequence: object.sequence,
        epoch: object.epoch,
        causeCommandId: object.causeCommandId,
        event,
      };
}

function decodeServerEvent(value: unknown): ServerEventEnvelope["event"] {
  const event = requireRecord(value, "server event");
  switch (event.type) {
    case "documentAccepted":
      requireNonemptyString(event.revision, "documentAccepted.revision");
      return { type: "documentAccepted", revision: event.revision };
    case "resyncRequired":
      if (!isResyncReason(event.reason)) {
        throw new TransportProtocolError("Malformed resyncRequired.reason");
      }
      return { type: "resyncRequired", reason: event.reason };
    case "presentationContentReplaced":
      requireNonemptyString(event.checkId, "presentationContentReplaced.checkId");
      return {
        type: "presentationContentReplaced",
        checkId: event.checkId,
        content: decodePresentationContent(event.content),
      };
    case "applyRequested":
      requireNonemptyString(event.actionId, "applyRequested.actionId");
      requireNonemptyString(event.transactionId, "applyRequested.transactionId");
      return {
        type: "applyRequested",
        actionId: event.actionId,
        transactionId: event.transactionId,
        request: decodeApplyRequest(event.request),
      };
    case "explanationReplaced":
      requireNonemptyString(event.actionId, "explanationReplaced.actionId");
      return {
        type: "explanationReplaced",
        actionId: event.actionId,
        update: decodeExplanationUpdate(event.update),
      };
    case "actionCompleted":
      requireNonemptyString(event.actionId, "actionCompleted.actionId");
      return { type: "actionCompleted", actionId: event.actionId };
    case "actionRejected":
      requireNonemptyString(event.actionId, "actionRejected.actionId");
      if (!isActionRejectionReason(event.reason)) {
        throw new TransportProtocolError("Malformed actionRejected.reason");
      }
      return { type: "actionRejected", actionId: event.actionId, reason: event.reason };
    case "fault":
      requireNonemptyString(event.code, "fault.code");
      if (typeof event.fatal !== "boolean") {
        throw new TransportProtocolError("fault.fatal must be a boolean");
      }
      return { type: "fault", code: event.code, fatal: event.fatal };
    default:
      throw new TransportProtocolError("Unknown server event type");
  }
}

function decodePresentationContent(value: unknown): PresentationContent {
  const content = requireRecord(value, "presentation content");
  requireNonemptyString(content.documentRevision, "presentation.documentRevision");
  if (!isPresentationStatus(content.status) || !Array.isArray(content.suggestions)) {
    throw new TransportProtocolError("Malformed presentation content");
  }
  const suggestions = content.suggestions.map(decodePresentedSuggestion);
  const appearance = decodePresentationAppearance(content.appearance);
  if (content.status === "complete") {
    if (content.coverage !== "full" && content.coverage !== "partial") {
      throw new TransportProtocolError("Complete presentation requires coverage");
    }
    return {
      documentRevision: content.documentRevision,
      status: "complete",
      coverage: content.coverage,
      appearance,
      suggestions,
    };
  }
  if (content.status === "unavailable") {
    if (!isUnavailableReason(content.unavailableReason)) {
      throw new TransportProtocolError("Unavailable presentation requires unavailableReason");
    }
    return {
      documentRevision: content.documentRevision,
      status: "unavailable",
      unavailableReason: content.unavailableReason,
      appearance,
      suggestions,
    };
  }
  return {
    documentRevision: content.documentRevision,
    status: content.status,
    appearance,
    suggestions,
  };
}

function decodePresentationAppearance(
  value: unknown,
): import("../integration/types").PresentationAppearance {
  const appearance = requireRecord(value, "presentation.appearance");
  const highlight = requireRecord(appearance.highlight, "presentation.appearance.highlight");
  const diff = requireRecord(appearance.diff, "presentation.appearance.diff");
  if (
    !hasExactKeys(appearance, ["highlight", "diff"]) ||
    !hasExactKeys(highlight, ["style", "grammarColor", "fluencyColor"]) ||
    !hasExactKeys(diff, [
      "additionColor",
      "deletionColor",
      "showHiddenWhitespace",
    ]) ||
    (highlight.style !== "underline" &&
      highlight.style !== "dashedUnderline" &&
      highlight.style !== "highlight") ||
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

function isCanonicalRGBColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9A-F]{6}$/.test(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => key in value);
}

function decodePresentedSuggestion(
  value: unknown,
): import("../integration/types").PresentedSuggestion {
  const suggestion = requireRecord(value, "presented suggestion");
  requireNonemptyString(suggestion.id, "suggestion.id");
  requireNonemptyString(suggestion.sourceId, "suggestion.sourceId");
  if (
    suggestion.kind !== "grammar" &&
    suggestion.kind !== "fluency" &&
    suggestion.kind !== "mixed"
  ) {
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
    !hasExactKeys(attribution, [
      "languageDisplayName",
      "textDirection",
      "checkModelDisplayName",
    ]) ||
    typeof attribution.languageDisplayName !== "string" ||
    attribution.languageDisplayName.length === 0 ||
    (attribution.textDirection !== "ltr" &&
      attribution.textDirection !== "rtl") ||
    typeof attribution.checkModelDisplayName !== "string" ||
    attribution.checkModelDisplayName.length === 0
  ) {
    throw new TransportProtocolError("Malformed suggestion attribution");
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
    highlightRanges: suggestion.highlightRanges.map(decodeRange),
    diff: suggestion.diff.map((run) => {
      const object = requireRecord(run, "diff run");
      if (
        (object.kind !== "unchanged" && object.kind !== "delete" && object.kind !== "insert") ||
        typeof object.text !== "string"
      ) {
        throw new TransportProtocolError("Malformed diff run");
      }
      return { kind: object.kind, text: object.text };
    }),
    availableActions: suggestion.availableActions.map((action) => {
      if (action !== "apply" && action !== "dismiss" && action !== "explain" && action !== "report") {
        throw new TransportProtocolError("Malformed suggestion action");
      }
      return action;
    }),
  };
}

function decodeApplyRequest(value: unknown): import("../integration/types").HostApplyRequest {
  const request = requireRecord(value, "apply request");
  requireNonemptyString(request.expectedRevision, "apply.expectedRevision");
  requireNonemptyString(request.sourceId, "apply.sourceId");
  if (!Array.isArray(request.edits) || request.edits.length === 0) {
    throw new TransportProtocolError("Apply request requires edits");
  }
  return {
    expectedRevision: request.expectedRevision,
    sourceId: request.sourceId,
    edits: request.edits.map((edit) => {
      const object = requireRecord(edit, "host edit");
      if (typeof object.expectedText !== "string" || typeof object.replacement !== "string") {
        throw new TransportProtocolError("Malformed host edit");
      }
      return {
        range: decodeRange(object.range),
        expectedText: object.expectedText,
        replacement: object.replacement,
      };
    }),
  };
}

function decodeRange(value: unknown): import("../integration/types").UTF16Range {
  const range = requireRecord(value, "UTF-16 range");
  if (!Number.isSafeInteger(range.location) || !Number.isSafeInteger(range.length)) {
    throw new TransportProtocolError("Range coordinates must be integers");
  }
  if ((range.location as number) < 0 || (range.length as number) < 0) {
    throw new TransportProtocolError("Range coordinates must be nonnegative");
  }
  return { location: range.location as number, length: range.length as number };
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
      !hasExactKeys(attribution, [
        "languageDisplayName",
        "textDirection",
        "modelDisplayName",
      ]) ||
      typeof attribution.languageDisplayName !== "string" ||
      attribution.languageDisplayName.length === 0 ||
      (attribution.textDirection !== "ltr" &&
        attribution.textDirection !== "rtl") ||
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

function requireNonemptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TransportProtocolError(`${label} must be a nonempty string`);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isUInt32(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
}

function isPresentationStatus(
  value: unknown,
): value is "pending" | "checking" | "complete" | "unavailable" | "closed" {
  return (
    value === "pending" ||
    value === "checking" ||
    value === "complete" ||
    value === "unavailable" ||
    value === "closed"
  );
}

function isUnavailableReason(
  value: unknown,
): value is
  | "disconnected"
  | "engineUnavailable"
  | "checkFailed"
  | "invalidDocument"
  | "unsupportedSource"
  | "resourceLimit";
function isUnavailableReason(value: unknown): boolean {
  return (
    value === "disconnected" ||
    value === "engineUnavailable" ||
    value === "checkFailed" ||
    value === "invalidDocument" ||
    value === "unsupportedSource" ||
    value === "resourceLimit"
  );
}

function isActionUnavailableReason(
  value: unknown,
): value is import("../integration/types").ActionUnavailableReason {
  return (
    value === "disconnected" ||
    value === "engineUnavailable" ||
    value === "validationUnavailable" ||
    value === "readOnly" ||
    value === "nonAtomic" ||
    value === "mutationUnavailable" ||
    value === "mutationIndeterminate" ||
    value === "applyNotProven" ||
    value === "reportingUnavailable"
  );
}

function isResyncReason(
  value: unknown,
): value is import("./wire").ResyncReason {
  return (
    value === "documentNotOpen" ||
    value === "conflictingRevision" ||
    value === "reusedRevision" ||
    value === "invalidDocument"
  );
}
