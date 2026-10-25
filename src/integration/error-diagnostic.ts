export interface IntegrationErrorDiagnostic {
  readonly schema: 1;
  readonly runID?: string;
  readonly boundary: "connection" | "integration" | "host";
  readonly category: ErrorCategory;
  readonly code: ErrorCode;
  readonly cause?: ErrorClassification;
}

type ErrorCategory =
  | "frame" | "transport" | "engineFault" | "host" | "engine"
  | "strictJSON" | "typeError" | "rangeError" | "syntaxError"
  | "socket" | "error" | "unknown";

interface ErrorClassification {
  readonly category: ErrorCategory;
  readonly code: ErrorCode;
}

const MESSAGE_CODES = {
  "Frame value is not JSON serializable": "frameSerialization",
  "Frame JSON root must be an object": "frameRoot",
  "Frame body must be between 1 and 8388608 bytes": "frameSize",
  "Declared frame length must be between 1 and 8388608 bytes": "declaredFrameSize",
  "Frame decoder cannot continue after a protocol error": "decoderFailed",
  "Frame body is not valid JSON": "frameJSON",
  "Socket ended in the middle of a frame": "truncatedFrame",
  "WritingHost.present failed": "hostPresent",
  "WritingHost.apply failed outside its outcome contract": "hostApply",
  "Refine reused a check ID for a different document revision": "checkRevisionChanged",
  "Refine regressed a check after its terminal presentation": "terminalCheckRegressed",
  "Refine removed determinate progress from an active check": "progressRemoved",
  "Refine changed the total progress count for an active check": "progressTotalChanged",
  "Refine decreased completed progress for an active check": "progressRegressed",
  "Refine returned an active check to pending": "checkReturnedToPending",
  "Refine attributed one check request to multiple check IDs": "checkAttributionChanged",
  "pending presentation contained suggestions": "unexpectedSuggestions",
  "unavailable presentation contained suggestions": "unexpectedSuggestions",
  "closed presentation contained suggestions": "unexpectedSuggestions",
  "Presentation contained a duplicate suggestion ID": "duplicateSuggestion",
  "Presentation referenced an unknown source ID": "unknownSource",
  "Presentation contained an invalid activation range": "activationRange",
  "Presentation contained an invalid highlight range": "highlightRange",
  "Refine sent malformed checking progress": "malformedProgress",
  "AsyncQueue buffer limit exceeded": "queueOverflow",
  "Refine server epoch changed during handshake": "epochChanged",
} as const;

const FAULT_CODES = [
  "invalidSequence", "malformedMessage", "resourceLimit", "internalError",
  "invalidDocument", "unsupportedSource", "engineUnavailable",
] as const;

const SOCKET_CODES = ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOENT", "ETIMEDOUT"] as const;

type ErrorCode =
  | (typeof MESSAGE_CODES)[keyof typeof MESSAGE_CODES]
  | (typeof FAULT_CODES)[number]
  | (typeof SOCKET_CODES)[number]
  | "unclassified";

/** Only fixed codes and one classified cause cross this privacy boundary. */
export function integrationErrorDiagnostic(
  runID: string,
  boundary: IntegrationErrorDiagnostic["boundary"],
  error: unknown,
): IntegrationErrorDiagnostic {
  const classification = classify(error);
  const cause = error instanceof Error ? error.cause : undefined;
  return {
    schema: 1,
    ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runID)
      ? { runID: runID.toLowerCase() } : {}),
    boundary,
    ...classification,
    ...(cause === undefined ? {} : { cause: classify(cause) }),
  };
}

function classify(error: unknown): ErrorClassification {
  if (!(error instanceof Error)) {
    return { category: "unknown", code: "unclassified" };
  }
  const rawCode: unknown = "code" in error ? error.code : undefined;
  if (error.name === "EngineFaultError") {
    return {
      category: "engineFault",
      code: FAULT_CODES.find((code) => code === rawCode) ?? "unclassified",
    };
  }
  const socketCode = SOCKET_CODES.find((code) => code === rawCode);
  if (socketCode !== undefined) {
    return { category: "socket", code: socketCode };
  }
  const code = Object.entries(MESSAGE_CODES).find(([message]) => message === error.message)?.[1]
    ?? "unclassified";
  const category: ErrorCategory = error.name === "FrameProtocolError" ? "frame"
    : error.name === "TransportProtocolError" || error.name === "EngineConnectionError"
      || error.name === "HandshakeRejectedError" || error.name === "IncompatibleProtocolError"
      || error.name === "EndpointReplacedError" ? "transport"
    : error.name === "FatalHostError" || code === "hostPresent" || code === "hostApply" ? "host"
    : error.name === "StrictJSONError" ? "strictJSON"
    : error instanceof TypeError ? "typeError"
    : error instanceof RangeError ? "rangeError"
    : error instanceof SyntaxError ? "syntaxError"
    : code !== "unclassified" ? "engine"
    : "error";
  return { category, code };
}
