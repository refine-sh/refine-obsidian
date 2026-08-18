import type {
  ActionUnavailableReason,
  CheckingProgress,
  CheckIntent,
  DocumentRevision,
  DocumentSnapshot,
  DiffRun,
  ExplanationUpdate,
  HostApplyOutcome,
  HostApplyRequest,
  PresentationAppearance,
  PresentationInteraction,
  PresentedSuggestion,
  QuickApplyActivationStyle,
  SourceSnapshot,
  SuggestionActionKind,
  SuggestionActionKey,
  SuggestionHighlightStyle,
  SuggestionAttribution,
  WritingAttention,
} from "../integration/types";
import type { MAX_FRAME_BYTES } from "./frame-codec";

export const PROTOCOL_MAJOR = 1 as const;
export const PROTOCOL_MINOR = 0 as const;
export const MAX_SOURCE_BYTES = 1_048_576 as const;
export const MAX_CAPABILITIES = 64 as const;

function isRegistryValue<const Values extends readonly unknown[]>(
  registry: Values,
  value: unknown,
): value is Values[number] {
  return registry.includes(value);
}

export const SUGGESTION_ACTION_KEYS = [
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
] as const satisfies readonly SuggestionActionKey[];

export function isSuggestionActionKey(value: unknown): value is SuggestionActionKey {
  return isRegistryValue(SUGGESTION_ACTION_KEYS, value);
}

export const SOURCE_SYNTAXES = [
  "plainText",
  "markdownDocument",
  "markdownDocumentHardLineBreaks",
  "latexDocument",
] as const satisfies readonly SourceSnapshot["sourceSyntax"][];

export function isSourceSyntax(value: unknown): value is SourceSnapshot["sourceSyntax"] {
  return isRegistryValue(SOURCE_SYNTAXES, value);
}

export const QUICK_APPLY_ACTIVATION_STYLES = [
  "highlightChanges",
  "showTipAndHighlight",
] as const satisfies readonly QuickApplyActivationStyle[];

export function isQuickApplyActivationStyle(
  value: unknown,
): value is QuickApplyActivationStyle {
  return isRegistryValue(QUICK_APPLY_ACTIVATION_STYLES, value);
}

export const SUGGESTION_HIGHLIGHT_STYLES = [
  "underline",
  "dashedUnderline",
  "highlight",
] as const satisfies readonly SuggestionHighlightStyle[];

export function isSuggestionHighlightStyle(
  value: unknown,
): value is SuggestionHighlightStyle {
  return isRegistryValue(SUGGESTION_HIGHLIGHT_STYLES, value);
}

export const SUGGESTION_KINDS = [
  "grammar",
  "fluency",
  "mixed",
] as const satisfies readonly PresentedSuggestion["kind"][];

export function isSuggestionKind(
  value: unknown,
): value is PresentedSuggestion["kind"] {
  return isRegistryValue(SUGGESTION_KINDS, value);
}

export const TEXT_DIRECTIONS = [
  "ltr",
  "rtl",
] as const satisfies readonly SuggestionAttribution["textDirection"][];

export function isTextDirection(
  value: unknown,
): value is SuggestionAttribution["textDirection"] {
  return isRegistryValue(TEXT_DIRECTIONS, value);
}

export const DIFF_RUN_KINDS = [
  "unchanged",
  "delete",
  "insert",
] as const satisfies readonly DiffRun["kind"][];

export function isDiffRunKind(value: unknown): value is DiffRun["kind"] {
  return isRegistryValue(DIFF_RUN_KINDS, value);
}

export const SUGGESTION_ACTION_KINDS = [
  "apply",
  "dismiss",
  "explain",
  "report",
] as const satisfies readonly SuggestionActionKind[];

export function isSuggestionActionKind(
  value: unknown,
): value is SuggestionActionKind {
  return isRegistryValue(SUGGESTION_ACTION_KINDS, value);
}

export const ACTION_UNAVAILABLE_REASONS = [
  "disconnected",
  "engineUnavailable",
  "validationUnavailable",
  "readOnly",
  "nonAtomic",
  "mutationUnavailable",
  "mutationIndeterminate",
  "applyNotProven",
  "reportingUnavailable",
] as const satisfies readonly ActionUnavailableReason[];

export function isActionUnavailableReason(
  value: unknown,
): value is ActionUnavailableReason {
  return isRegistryValue(ACTION_UNAVAILABLE_REASONS, value);
}

export const APPLY_REJECTION_REASONS = [
  "staleRevision",
  "textMismatch",
] as const satisfies readonly Extract<
  HostApplyOutcome,
  { readonly status: "rejected" }
>["reason"][];

export function isApplyRejectionReason(
  value: unknown,
): value is (typeof APPLY_REJECTION_REASONS)[number] {
  return isRegistryValue(APPLY_REJECTION_REASONS, value);
}

export const APPLY_UNSUPPORTED_REASONS = [
  "readOnly",
  "nonAtomic",
] as const satisfies readonly Extract<
  HostApplyOutcome,
  { readonly status: "unsupported" }
>["reason"][];

export function isApplyUnsupportedReason(
  value: unknown,
): value is (typeof APPLY_UNSUPPORTED_REASONS)[number] {
  return isRegistryValue(APPLY_UNSUPPORTED_REASONS, value);
}

export interface IntegrationClientIdentity {
  readonly id: string;
  readonly version: string;
  readonly host: string;
}

export interface HelloFrame {
  readonly type: "hello";
  readonly protocol: {
    readonly major: typeof PROTOCOL_MAJOR;
    readonly minor: typeof PROTOCOL_MINOR;
  };
  readonly client: IntegrationClientIdentity;
  readonly frontend?: { readonly id: string };
  readonly hostCapabilities: {
    readonly interceptableSuggestionActionKeys: readonly SuggestionActionKey[];
  };
  readonly runId: string;
  readonly launchToken: string;
  readonly capabilities: readonly string[];
}

export interface WelcomeFrame {
  readonly type: "welcome";
  readonly protocol: {
    readonly major: typeof PROTOCOL_MAJOR;
    readonly minor: typeof PROTOCOL_MINOR;
  };
  readonly serverEpoch: string;
  readonly runResumed: boolean;
  readonly limits: {
    readonly maxFrameBytes: typeof MAX_FRAME_BYTES;
    readonly maxSources: 2;
    readonly maxSourceBytes: typeof MAX_SOURCE_BYTES;
  };
  readonly capabilities: readonly string[];
}

export interface WireProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

export const HANDSHAKE_RECOVERIES = ["none", "retry", "newRun"] as const;
export type HandshakeRecovery = (typeof HANDSHAKE_RECOVERIES)[number];

export type HandshakeRejectedFrame =
  | {
      readonly type: "rejected";
      readonly reason: "incompatibleProtocol";
      readonly recovery: "none";
      readonly protocol: {
        readonly major: typeof PROTOCOL_MAJOR;
        readonly minor: typeof PROTOCOL_MINOR;
      };
      readonly receivedProtocol: WireProtocolVersion;
    }
  | {
      readonly type: "rejected";
      readonly reason: "invalidClient";
      readonly recovery: "none";
      readonly protocol: {
        readonly major: typeof PROTOCOL_MAJOR;
        readonly minor: typeof PROTOCOL_MINOR;
      };
    }
  | {
      readonly type: "rejected";
      readonly reason: "runUnavailable";
      readonly recovery: "newRun" | "retry";
      readonly protocol: {
        readonly major: typeof PROTOCOL_MAJOR;
        readonly minor: typeof PROTOCOL_MINOR;
      };
    }
  | {
      readonly type: "rejected";
      readonly reason: "serverBusy" | "engineUnavailable";
      readonly recovery: "retry";
      readonly protocol: {
        readonly major: typeof PROTOCOL_MAJOR;
        readonly minor: typeof PROTOCOL_MINOR;
      };
    };

export type ClientCommand =
  | { readonly type: "openDocument"; readonly snapshot: DocumentSnapshot }
  | { readonly type: "replaceDocument"; readonly snapshot: DocumentSnapshot }
  | {
      readonly type: "updateAttention";
      readonly revision: DocumentRevision;
      readonly attention: WritingAttention;
    }
  | {
      readonly type: "requestCheck";
      readonly revision: DocumentRevision;
      readonly intent?: CheckIntent;
    }
  | {
      readonly type: "performAction";
      readonly actionId: string;
      readonly kind: "apply" | "dismiss" | "explain" | "report";
      readonly suggestion: {
        readonly id: string;
        readonly documentRevision: DocumentRevision;
      };
    }
  | {
      readonly type: "completeApply";
      readonly transactionId: string;
      readonly outcome: HostApplyOutcome;
    }
  | { readonly type: "closeDocument" };

export interface ClientCommandEnvelope {
  readonly type: "command";
  readonly sequence: number;
  readonly id: string;
  readonly command: ClientCommand;
}

export interface PresentationContent {
  readonly documentRevision: DocumentRevision;
  readonly appearance: PresentationAppearance;
  readonly interaction: PresentationInteraction;
  readonly status: PresentationStatus;
  readonly progress?: CheckingProgress;
  readonly coverage?: PresentationCoverage;
  readonly unavailableReason?: PresentationUnavailableReason;
  readonly suggestions: readonly PresentedSuggestion[];
}

export const PRESENTATION_STATUSES = [
  "pending",
  "checking",
  "complete",
  "unavailable",
  "closed",
] as const;
export type PresentationStatus = (typeof PRESENTATION_STATUSES)[number];

export function isPresentationStatus(value: unknown): value is PresentationStatus {
  return isRegistryValue(PRESENTATION_STATUSES, value);
}

export const PRESENTATION_COVERAGES = ["full", "partial"] as const;
export type PresentationCoverage = (typeof PRESENTATION_COVERAGES)[number];

export function isPresentationCoverage(
  value: unknown,
): value is PresentationCoverage {
  return isRegistryValue(PRESENTATION_COVERAGES, value);
}

export const PRESENTATION_UNAVAILABLE_REASONS = [
  "disconnected",
  "engineUnavailable",
  "checkFailed",
  "invalidDocument",
  "unsupportedSource",
  "resourceLimit",
  "writingCheckEntitlementRequired",
] as const;
export type PresentationUnavailableReason =
  (typeof PRESENTATION_UNAVAILABLE_REASONS)[number];

export function isPresentationUnavailableReason(
  value: unknown,
): value is PresentationUnavailableReason {
  return isRegistryValue(PRESENTATION_UNAVAILABLE_REASONS, value);
}

export const RESYNC_REASONS = [
  "documentNotOpen",
  "conflictingRevision",
  "reusedRevision",
  "invalidDocument",
] as const;
export type ResyncReason = (typeof RESYNC_REASONS)[number];

export function isResyncReason(value: unknown): value is ResyncReason {
  return isRegistryValue(RESYNC_REASONS, value);
}

export const ACTION_REJECTION_REASONS = [
  "stale",
  "disconnected",
  "engineUnavailable",
  "validationUnavailable",
  "readOnly",
  "nonAtomic",
  "mutationUnavailable",
  "mutationIndeterminate",
  "applyNotProven",
  "reportingUnavailable",
  "unsupportedAction",
] as const;

export type ActionRejectionReason = (typeof ACTION_REJECTION_REASONS)[number];

export function isActionRejectionReason(value: unknown): value is ActionRejectionReason {
  return isRegistryValue(ACTION_REJECTION_REASONS, value);
}

export type ServerEvent =
  | { readonly type: "documentAccepted"; readonly revision: DocumentRevision }
  | { readonly type: "resyncRequired"; readonly reason: ResyncReason }
  | {
      readonly type: "presentationContentReplaced";
      readonly checkId: string;
      readonly content: PresentationContent;
    }
  | {
      readonly type: "applyRequested";
      readonly actionId: string;
      readonly transactionId: string;
      readonly request: HostApplyRequest;
    }
  | {
      readonly type: "explanationReplaced";
      readonly actionId: string;
      readonly update: ExplanationUpdate;
    }
  | { readonly type: "actionCompleted"; readonly actionId: string }
  | {
      readonly type: "actionRejected";
      readonly actionId: string;
      readonly reason: ActionRejectionReason;
    }
  | ServerFault;

export const FAULT_FATALITIES = {
  invalidSequence: [true],
  malformedMessage: [false, true],
  resourceLimit: [false, true],
  internalError: [false, true],
  invalidDocument: [false],
  unsupportedSource: [false],
  engineUnavailable: [false],
} as const satisfies Readonly<Record<string, readonly boolean[]>>;

export type FaultCode = keyof typeof FAULT_FATALITIES;
export type ServerFault = {
  [Code in FaultCode]: {
    readonly type: "fault";
    readonly code: Code;
    readonly fatal: (typeof FAULT_FATALITIES)[Code][number];
  };
}[FaultCode];

export function isFaultSeverityPair(code: unknown, fatal: unknown): boolean {
  return typeof code === "string" &&
    Object.hasOwn(FAULT_FATALITIES, code) &&
    isRegistryValue(
      FAULT_FATALITIES[code as FaultCode] as readonly boolean[],
      fatal,
    );
}

export interface ServerEventEnvelope {
  readonly type: "event";
  readonly sequence: number;
  readonly epoch: string;
  readonly causeCommandId?: string;
  readonly event: ServerEvent;
}
