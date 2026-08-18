import { foldedRanges } from "@codemirror/language";
import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";

import type {
  CheckIntent,
  DocumentRevision,
  DocumentSnapshot,
  HostApplyOutcome,
  HostApplyRequest,
  HostEdit,
  HostObservation,
  HostRevisionValidation,
  PresentationSnapshot,
  SuggestionActions,
  UTF16Range,
} from "../integration/types";
import { AsyncQueue } from "../shared/async-queue";
import { unicodeScalarBoundaries } from "../shared/unicode-scalar-boundaries";
import {
  clearLivePresentationPreservingProvisional,
  clearPresentation,
  installPresentation,
  refinePresentationExtension,
  type ExplanationRenderer,
} from "./presentation";

export interface ObsidianWritingHostOptions {
  readonly sessionId?: string;
  readonly onPresentation?: (snapshot: PresentationSnapshot) => void;
  readonly renderExplanation?: ExplanationRenderer;
}

const DOCUMENT_SOURCE_ID = "document";

/**
 * Obsidian renders every source line ending as a line break in a default vault,
 * so Refine must keep each one exactly where the author put it. This syntax
 * still checks prose wrapped across source lines as one logical paragraph; it
 * only forbids Refine from moving, removing, or introducing a line ending.
 */
const DOCUMENT_SOURCE_SYNTAX = "markdownDocumentHardLineBreaks";

interface HostViewBridge {
  readonly extension: Compartment;
  owner: ObsidianWritingHost | undefined;
}

type AttentionObservation = Extract<
  HostObservation,
  { readonly type: "attentionChanged" }
>;

const hostViewBridges = new WeakMap<EditorView, HostViewBridge>();

export class ObsidianWritingHost {
  private readonly bridge: HostViewBridge;
  private readonly onPresentation: (snapshot: PresentationSnapshot) => void;
  private readonly sessionId: string;
  private readonly renderExplanation: ExplanationRenderer | undefined;
  private incarnation = 0;
  private currentText: string;
  private observations: AsyncQueue<HostObservation> | undefined;
  private lastAttention: AttentionObservation | undefined;
  private attentionSuspendedForFocusLoss = false;
  private readonly pendingRequests: HostObservation[] = [];
  private closed = false;

  constructor(
    private readonly view: EditorView,
    options: ObsidianWritingHostOptions = {},
  ) {
    this.sessionId = options.sessionId ?? crypto.randomUUID();
    this.onPresentation = options.onPresentation ?? (() => undefined);
    this.renderExplanation = options.renderExplanation;
    this.currentText = this.view.state.doc.toString();
    const existing = hostViewBridges.get(view);
    if (existing) {
      this.bridge = existing;
      this.view.dispatch({
        effects:
          existing.extension.get(this.view.state) === undefined
            ? StateEffect.appendConfig.of(
                existing.extension.of(this.activeViewExtension(existing)),
              )
            : existing.extension.reconfigure(
                this.activeViewExtension(existing),
              ),
      });
    } else {
      const bridge: HostViewBridge = {
        extension: new Compartment(),
        owner: undefined,
      };
      hostViewBridges.set(view, bridge);
      this.bridge = bridge;
      this.view.dispatch({
        effects: StateEffect.appendConfig.of(
          bridge.extension.of(this.activeViewExtension(bridge)),
        ),
      });
    }
    this.bridge.owner = this;
  }

  async *observe(signal: AbortSignal): AsyncIterable<HostObservation> {
    if (this.closed) {
      return;
    }
    if (this.observations) {
      throw new Error("ObsidianWritingHost supports one observer at a time");
    }

    const queue = new AsyncQueue<HostObservation>(128, (previous, next) => {
      if (previous.type === "snapshot" && next.type === "snapshot") {
        return next;
      }
      return previous.type === "attentionChanged" &&
        next.type === "attentionChanged" &&
        previous.revision === next.revision
        ? next
        : undefined;
    });
    this.observations = queue;
    const abort = (): void => queue.close();
    signal.addEventListener("abort", abort, { once: true });
    queue.push(this.snapshotObservation());
    const attention = this.attentionObservation();
    this.lastAttention = attention;
    queue.push(attention);
    for (const request of this.pendingRequests.splice(0)) {
      queue.push(request);
    }

    try {
      yield* queue;
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.observations === queue) {
        this.observations = undefined;
      }
    }
  }

  validateRevision(revision: DocumentRevision): Promise<HostRevisionValidation> {
    if (this.closed) {
      return Promise.resolve({ status: "unavailable" });
    }

    const snapshot = this.snapshot();
    return Promise.resolve(
      snapshot.revision === revision
        ? { status: "current" }
        : { status: "stale", snapshot },
    );
  }

  async apply(request: HostApplyRequest): Promise<HostApplyOutcome> {
    if (this.closed) {
      return { status: "unavailable" };
    }

    const before = this.snapshot();
    if (before.revision !== request.expectedRevision) {
      return { status: "rejected", reason: "staleRevision", snapshot: before };
    }
    if (request.sourceId !== DOCUMENT_SOURCE_ID || !this.validEdits(request.edits)) {
      return { status: "unavailable", snapshot: before };
    }
    if (!this.view.state.facet(EditorView.editable)) {
      return { status: "unsupported", reason: "readOnly", snapshot: before };
    }

    const original = before.sources[0]?.text;
    if (original === undefined) {
      return { status: "unavailable", snapshot: before };
    }
    for (const edit of request.edits) {
      const { location, length } = edit.range;
      if (original.slice(location, location + length) !== edit.expectedText) {
        return { status: "rejected", reason: "textMismatch", snapshot: before };
      }
    }

    const expected = this.applyToText(original, request.edits);
    try {
      const changes = [...request.edits]
        .reverse()
        .map((edit) => ({
          from: edit.range.location,
          to: edit.range.location + edit.range.length,
          insert: edit.replacement,
        }));
      this.view.dispatch({ changes, userEvent: "input.refine.apply" });
    } catch {
      const afterFailure = this.snapshot();
      return afterFailure.sources[0]?.text === original
        ? { status: "unavailable", snapshot: afterFailure }
        : { status: "indeterminate", snapshot: afterFailure };
    }

    const after = this.snapshot();
    return after.revision !== before.revision && after.sources[0]?.text === expected
      ? { status: "applied", snapshot: after }
      : { status: "indeterminate", snapshot: after };
  }

  present(snapshot: PresentationSnapshot, actions: SuggestionActions): void {
    if (this.closed) {
      return;
    }
    if (snapshot.documentRevision !== this.snapshot().revision) {
      clearLivePresentationPreservingProvisional(this.view);
      return;
    }
    installPresentation(
      this.view,
      snapshot,
      actions,
      this.renderExplanation,
    );
    this.onPresentation(snapshot);
  }

  requestCheck(intent?: CheckIntent): void {
    if (this.closed) {
      return;
    }
    const observation: HostObservation =
      intent === undefined
        ? { type: "checkRequested", revision: this.snapshot().revision }
        : { type: "checkRequested", revision: this.snapshot().revision, intent };
    if (this.observations) {
      this.observations.push(observation);
    } else {
      this.pendingRequests.push(observation);
    }
  }

  isAttached(): boolean {
    return (
      !this.closed &&
      this.bridge.owner === this &&
      this.bridge.extension.get(this.view.state) !== undefined
    );
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.observations?.close();
    this.observations = undefined;
    this.pendingRequests.length = 0;
    if (this.bridge.owner === this) {
      clearPresentation(this.view);
      this.bridge.owner = undefined;
      if (this.bridge.extension.get(this.view.state) !== undefined) {
        this.view.dispatch({ effects: this.bridge.extension.reconfigure([]) });
      }
    }
  }

  private activeViewExtension(bridge: HostViewBridge) {
    return [
      refinePresentationExtension(this.view.dom.ownerDocument),
      EditorView.updateListener.of((update) => {
        bridge.owner?.viewUpdated(update);
      }),
    ];
  }

  private viewUpdated(update: ViewUpdate): void {
    if (this.closed || this.bridge.owner !== this) {
      return;
    }
    if (update.docChanged) {
      this.documentChanged();
    }
    if (update.focusChanged) {
      this.attentionSuspendedForFocusLoss = !update.view.hasFocus;
      if (update.view.hasFocus) {
        this.emitAttention(true);
      }
      return;
    }
    if (!this.attentionSuspendedForFocusLoss) {
      this.emitAttention(false);
    }
  }

  private emitAttention(force: boolean): void {
    if (!this.observations) {
      return;
    }
    const observation = this.attentionObservation();
    if (!force && sameAttentionObservation(this.lastAttention, observation)) {
      return;
    }
    this.lastAttention = observation;
    this.observations.push(observation);
  }

  private documentChanged(): void {
    if (this.closed || this.bridge.owner !== this) {
      return;
    }
    this.refreshIncarnation();
    this.observations?.push(this.snapshotObservation());
  }

  private snapshotObservation(): HostObservation {
    return { type: "snapshot", snapshot: this.snapshot() };
  }

  private attentionObservation(): AttentionObservation {
    const selection = this.view.state.selection;
    const caretOffset =
      selection.ranges.length === 1 && selection.main.empty
        ? selection.main.head
        : undefined;
    return {
      type: "attentionChanged",
      // `docChanged` refreshes the authoritative snapshot before the paired
      // attention update. Caret and viewport churn must not stringify a large
      // unchanged document just to recover its already-known revision.
      revision: this.currentRevision(),
      attention: {
        sourceId: DOCUMENT_SOURCE_ID,
        ...(caretOffset === undefined ? {} : { caretOffset }),
        visibleRanges: attentionVisibleRanges(this.view),
      },
    };
  }

  private snapshot(): DocumentSnapshot {
    this.refreshIncarnation();
    return {
      revision: this.currentRevision(),
      sources: [
        {
          sourceId: DOCUMENT_SOURCE_ID,
          sourceSyntax: DOCUMENT_SOURCE_SYNTAX,
          text: this.currentText,
        },
      ],
    };
  }

  private currentRevision(): string {
    return `${this.sessionId}:${this.incarnation}`;
  }

  private validEdits(edits: readonly HostEdit[]): boolean {
    if (edits.length === 0) {
      return false;
    }

    const boundaries = unicodeScalarBoundaries(this.currentText);
    let nextHigherStart = Number.POSITIVE_INFINITY;
    for (const edit of edits) {
      const { location, length } = edit.range;
      if (
        !Number.isSafeInteger(location) ||
        !Number.isSafeInteger(length) ||
        location < 0 ||
        length < 0 ||
        location + length > this.view.state.doc.length ||
        !boundaries.has(location) ||
        !boundaries.has(location + length) ||
        location + length > nextHigherStart ||
        (location === nextHigherStart && length === 0) ||
        (length === 0 && edit.replacement.length === 0) ||
        (length > 0 && edit.expectedText === edit.replacement)
      ) {
        return false;
      }
      nextHigherStart = location;
    }
    return true;
  }

  private refreshIncarnation(): void {
    const text = this.view.state.doc.toString();
    if (text !== this.currentText) {
      this.currentText = text;
      this.incarnation += 1;
    }
  }

  private applyToText(text: string, edits: readonly HostEdit[]): string {
    let result = text;
    for (const edit of edits) {
      const { location, length } = edit.range;
      result = `${result.slice(0, location)}${edit.replacement}${result.slice(location + length)}`;
    }
    return result;
  }
}

function attentionVisibleRanges(view: EditorView): readonly UTF16Range[] {
  const folds = foldedRanges(view.state);
  const visible: UTF16Range[] = [];
  for (const range of view.visibleRanges) {
    let cursor = range.from;
    folds.between(range.from, range.to, (from, to) => {
      if (from > cursor) {
        visible.push({ location: cursor, length: from - cursor });
      }
      cursor = Math.max(cursor, to);
    });
    if (cursor < range.to) {
      visible.push({ location: cursor, length: range.to - cursor });
    }
  }
  return visible;
}

function sameAttentionObservation(
  left: AttentionObservation | undefined,
  right: AttentionObservation,
): boolean {
  if (
    left?.revision !== right.revision ||
    left.attention.sourceId !== right.attention.sourceId ||
    left.attention.caretOffset !== right.attention.caretOffset ||
    left.attention.visibleRanges.length !== right.attention.visibleRanges.length
  ) {
    return false;
  }
  return left.attention.visibleRanges.every((range, index) => {
    const other = right.attention.visibleRanges[index];
    return other?.location === range.location && other.length === range.length;
  });
}
