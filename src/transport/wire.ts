import type {
  CheckingProgress,
  CheckIntent,
  DocumentRevision,
  DocumentSnapshot,
  ExplanationUpdate,
  HostApplyOutcome,
  HostApplyRequest,
  PresentationAppearance,
  PresentationInteraction,
  PresentedSuggestion,
  SuggestionActionKey,
  WritingAttention,
} from "../integration/types";
import type { MAX_FRAME_BYTES } from "./frame-codec";

export const PROTOCOL_MAJOR = 2 as const;
export const PROTOCOL_MINOR = 5 as const;

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

export interface IntegrationClientIdentity {
  readonly id: string;
  readonly version: string;
  readonly host: string;
}

export interface HelloFrame {
  readonly type: "hello";
  readonly protocol: { readonly major: 2; readonly minor: 5 };
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
  readonly protocol: { readonly major: 2; readonly minor: 5 };
  readonly serverEpoch: string;
  readonly runResumed: boolean;
  readonly limits: {
    readonly maxFrameBytes: typeof MAX_FRAME_BYTES;
    readonly maxSources: 2;
  };
  readonly capabilities: readonly string[];
}

export interface HandshakeRejectedFrame {
  readonly type: "rejected";
  readonly reason: "incompatibleProtocol";
  readonly protocol: {
    readonly major: number;
    readonly minor: number;
  };
}

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
  readonly status: "pending" | "checking" | "complete" | "unavailable" | "closed";
  readonly progress?: CheckingProgress;
  readonly coverage?: "full" | "partial";
  readonly unavailableReason?:
    | "disconnected"
    | "engineUnavailable"
    | "checkFailed"
    | "invalidDocument"
    | "unsupportedSource"
    | "resourceLimit"
    | "writingCheckEntitlementRequired";
  readonly suggestions: readonly PresentedSuggestion[];
}

export type ResyncReason =
  | "documentNotOpen"
  | "conflictingRevision"
  | "reusedRevision"
  | "invalidDocument";

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
  return (ACTION_REJECTION_REASONS as readonly unknown[]).includes(value);
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
  | { readonly type: "fault"; readonly code: string; readonly fatal: boolean };

export interface ServerEventEnvelope {
  readonly type: "event";
  readonly sequence: number;
  readonly epoch: string;
  readonly causeCommandId?: string;
  readonly event: ServerEvent;
}
