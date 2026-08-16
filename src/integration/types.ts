export type DocumentRevision = string;
export type SourceID = string;

export interface DocumentSnapshot {
  readonly revision: DocumentRevision;
  readonly sources: readonly SourceSnapshot[];
}

export interface SourceSnapshot {
  readonly sourceId: SourceID;
  readonly text: string;
  readonly sourceSyntax: "plainText" | "markdownDocument" | "latexDocument";
}

export type HostObservation =
  | { readonly type: "snapshot"; readonly snapshot: DocumentSnapshot }
  | {
      readonly type: "checkRequested";
      readonly revision: DocumentRevision;
      readonly intent?: CheckIntent;
    };

export type CheckIntent =
  | {
      readonly forcedLanguageTag?: string;
      readonly sourceIds?: readonly SourceID[];
      readonly selection?: never;
    }
  | {
      readonly forcedLanguageTag?: string;
      readonly sourceIds?: never;
      readonly selection: {
        readonly sourceId: SourceID;
        readonly range: UTF16Range;
      };
    };

export type HostRevisionValidation =
  | { readonly status: "current" }
  | { readonly status: "stale"; readonly snapshot: DocumentSnapshot }
  | { readonly status: "unavailable" };

export interface UTF16Range {
  readonly location: number;
  readonly length: number;
}

export interface DiffRun {
  readonly kind: "unchanged" | "delete" | "insert";
  readonly text: string;
}

export type SuggestionHighlightStyle = "underline" | "dashedUnderline" | "highlight";

export interface PresentationAppearance {
  readonly highlight: {
    readonly style: SuggestionHighlightStyle;
    readonly grammarColor: string;
    readonly fluencyColor: string;
  };
  readonly diff: {
    readonly additionColor: string;
    readonly deletionColor: string;
    readonly showHiddenWhitespace: boolean;
  };
}

export const DEFAULT_PRESENTATION_APPEARANCE: PresentationAppearance = {
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
};

export type SuggestionActionKey =
  | "tab"
  | "escape"
  | "return"
  | "space"
  | "delete"
  | "leftArrow"
  | "rightArrow"
  | "upArrow"
  | "downArrow"
  | "leftShift"
  | "rightShift"
  | "leftOption"
  | "rightOption"
  | "leftControl"
  | "rightControl";

export type QuickApplyActivationStyle =
  | "highlightChanges"
  | "showTipAndHighlight";

export interface PresentationInteraction {
  readonly automaticChecksEnabled: boolean;
  readonly quickApply: {
    readonly enabled: boolean;
    readonly applyKey: SuggestionActionKey;
    readonly dismissKey: SuggestionActionKey;
    readonly activationStyle: QuickApplyActivationStyle;
  };
}

export const DEFAULT_PRESENTATION_INTERACTION: PresentationInteraction = {
  automaticChecksEnabled: true,
  quickApply: {
    enabled: true,
    applyKey: "tab",
    dismissKey: "escape",
    activationStyle: "showTipAndHighlight",
  },
};

export type SuggestionActionKind = "apply" | "dismiss" | "explain" | "report";

export interface SuggestionAttribution {
  readonly languageDisplayName: string;
  readonly textDirection: "ltr" | "rtl";
  readonly checkModelDisplayName: string;
}

export interface PresentedSuggestion {
  readonly id: string;
  readonly sourceId: SourceID;
  readonly kind: "grammar" | "fluency" | "mixed";
  readonly attribution: SuggestionAttribution;
  readonly activationRange: UTF16Range;
  readonly highlightRanges: readonly UTF16Range[];
  readonly diff: readonly DiffRun[];
  readonly availableActions: readonly SuggestionActionKind[];
}

export interface CheckingProgress {
  readonly completedUnitCount: number;
  readonly totalUnitCount: number;
}

export interface PresentationSnapshot {
  readonly documentRevision: DocumentRevision;
  readonly presentationRevision: number;
  readonly checkGeneration: number;
  readonly appearance: PresentationAppearance;
  readonly interaction: PresentationInteraction;
  readonly state:
    | { readonly type: "pending" }
    | { readonly type: "checking"; readonly progress?: CheckingProgress }
    | { readonly type: "complete"; readonly coverage: "full" | "partial" }
    | {
        readonly type: "unavailable";
        readonly reason:
          | "disconnected"
          | "engineUnavailable"
          | "checkFailed"
          | "invalidDocument"
          | "unsupportedSource"
          | "resourceLimit"
          | "writingCheckEntitlementRequired";
      }
    | { readonly type: "closed" };
  readonly suggestions: readonly PresentedSuggestion[];
}

export interface SuggestionActions {
  apply(suggestionId: string): Promise<ActionOutcome>;
  dismiss(suggestionId: string): Promise<ActionOutcome>;
  explain(suggestionId: string): AsyncIterable<ExplanationUpdate>;
  report(suggestionId: string): Promise<ActionOutcome>;
}

export type ActionOutcome =
  | { readonly status: "completed" }
  | { readonly status: "stale" }
  | {
      readonly status: "unavailable";
      readonly reason: ActionUnavailableReason;
    };

export type ActionUnavailableReason =
  | "disconnected"
  | "engineUnavailable"
  | "validationUnavailable"
  | "readOnly"
  | "nonAtomic"
  | "mutationUnavailable"
  | "mutationIndeterminate"
  | "applyNotProven"
  | "reportingUnavailable";

export type ExplanationUpdate =
  | {
      readonly status: "started";
      readonly attribution: {
        readonly languageDisplayName: string;
        readonly textDirection: "ltr" | "rtl";
        readonly modelDisplayName: string;
      };
    }
  | {
      readonly status: "streaming" | "completed";
      readonly text: string;
    }
  | { readonly status: "stale" }
  | {
      readonly status: "unavailable";
      readonly reason: ActionUnavailableReason;
    };

export interface HostApplyRequest {
  readonly expectedRevision: DocumentRevision;
  readonly sourceId: SourceID;
  readonly edits: readonly HostEdit[];
}

export interface HostEdit {
  readonly range: UTF16Range;
  readonly expectedText: string;
  readonly replacement: string;
}

export type HostApplyOutcome =
  | { readonly status: "applied"; readonly snapshot: DocumentSnapshot }
  | {
      readonly status: "rejected";
      readonly reason: "staleRevision" | "textMismatch";
      readonly snapshot: DocumentSnapshot;
    }
  | {
      readonly status: "unsupported";
      readonly reason: "readOnly" | "nonAtomic";
      readonly snapshot?: DocumentSnapshot;
    }
  | {
      readonly status: "unavailable";
      readonly snapshot?: DocumentSnapshot;
    }
  | {
      readonly status: "indeterminate";
      readonly snapshot?: DocumentSnapshot;
    };

export interface WritingHost {
  observe(signal: AbortSignal): AsyncIterable<HostObservation>;
  validateRevision(revision: DocumentRevision): Promise<HostRevisionValidation>;
  apply(request: HostApplyRequest): Promise<HostApplyOutcome>;
  present(
    snapshot: PresentationSnapshot,
    actions: SuggestionActions,
  ): void | Promise<void>;
}

export interface RefineIntegration {
  run(input: { readonly host: WritingHost; readonly signal: AbortSignal }): Promise<void>;
}
