import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

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
} from "../integration/types";
import { AsyncQueue } from "../shared/async-queue";
import { graphemeBoundaries } from "../shared/grapheme-boundaries";
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

interface HostViewBridge {
  readonly extension: Compartment;
  owner: ObsidianWritingHost | undefined;
}

const hostViewBridges = new WeakMap<EditorView, HostViewBridge>();

export class ObsidianWritingHost {
  private readonly bridge: HostViewBridge;
  private readonly onPresentation: (snapshot: PresentationSnapshot) => void;
  private readonly sessionId: string;
  private readonly renderExplanation: ExplanationRenderer | undefined;
  private incarnation = 0;
  private currentText: string;
  private observations: AsyncQueue<HostObservation> | undefined;
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

    const queue = new AsyncQueue<HostObservation>(128, (previous, next) =>
      previous.type === "snapshot" && next.type === "snapshot" ? next : undefined,
    );
    this.observations = queue;
    const abort = (): void => queue.close();
    signal.addEventListener("abort", abort, { once: true });
    queue.push(this.snapshotObservation());
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
        if (update.docChanged) {
          bridge.owner?.documentChanged();
        }
      }),
    ];
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

  private snapshot(): DocumentSnapshot {
    this.refreshIncarnation();
    return {
      revision: `${this.sessionId}:${this.incarnation}`,
      sources: [
        {
          sourceId: DOCUMENT_SOURCE_ID,
          sourceSyntax: "markdownDocument",
          text: this.currentText,
        },
      ],
    };
  }

  private validEdits(edits: readonly HostEdit[]): boolean {
    if (edits.length === 0) {
      return false;
    }

    const boundaries = graphemeBoundaries(this.currentText);
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
