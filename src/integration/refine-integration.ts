import { isFatalEngineConnectionError } from "../transport/engine-connection-error";
import { AsyncQueue } from "../shared/async-queue";
import { graphemeBoundaries } from "../shared/grapheme-boundaries";
import type {
  CommandReceipt,
  RefineTransportSession,
} from "../transport/refine-transport";
import type {
  ActionRejectionReason,
  ClientCommand,
  PresentationContent,
  ServerEventEnvelope,
} from "../transport/wire";
import type {
  ActionOutcome,
  CheckIntent,
  DocumentSnapshot,
  ExplanationUpdate,
  HostApplyOutcome,
  HostObservation,
  PresentationSnapshot,
  PresentedSuggestion,
  RefineIntegration,
  SuggestionActionKind,
  SuggestionActions,
  WritingHost,
} from "./types";
import {
  DEFAULT_PRESENTATION_APPEARANCE,
  DEFAULT_PRESENTATION_INTERACTION,
} from "./types";

export interface WritingCheckEnginePort {
  connect(
    signal: AbortSignal,
    options?: { readonly runId: string },
  ): Promise<RefineTransportSession>;
}

export interface RefineIntegrationOptions {
  readonly enginePort: WritingCheckEnginePort;
  readonly reconnectDelayMs?: number;
}

export function createRefineIntegration(options: RefineIntegrationOptions): RefineIntegration {
  return {
    run: async ({ host, signal }) => {
      const run = new IntegrationRun(
        host,
        options.enginePort,
        signal,
        options.reconnectDelayMs ?? 1_000,
      );
      await run.start();
    },
  };
}

interface PendingAction {
  readonly id: string;
  readonly key: string;
  readonly kind: SuggestionActionKind;
  readonly suggestionId: string;
  readonly basePresentation: PresentationSnapshot;
  readonly result: Deferred<ActionOutcome>;
  readonly explanation?: AsyncQueue<ExplanationUpdate>;
  transactionId?: string;
}

interface HostObservationCycle {
  readonly controller: AbortController;
  readonly iterator: AsyncIterator<HostObservation>;
  readonly detach: () => void;
}

interface CheckPresentationLifecycle {
  readonly documentRevision: string;
  checkingStarted: boolean;
  completed: boolean;
  closed: boolean;
  originCauseCommandId: string | undefined;
  progress?: {
    readonly completedUnitCount: number;
    readonly totalUnitCount: number;
  };
}

interface PresentationReplayAlias {
  readonly causeCommandId: string;
  readonly documentRevision: string;
  readonly checkId: string;
}

interface CheckIdAlias {
  readonly documentRevision: string;
  readonly canonicalCheckId: string;
  readonly bindsActiveCheckLifecycle: boolean;
}

interface ActionPresentationAlias extends CheckIdAlias {
  readonly actionId: string;
}

interface ResumableCheckLifecycle {
  readonly checkId: string;
  readonly terminalOwnerCheckId: string;
}

const MAX_BUFFERED_ENGINE_EVENTS = 128;

class IntegrationRun {
  private readonly runId = globalThis.crypto.randomUUID();
  private readonly lifecycle = new AbortController();
  private readonly pendingActions = new Map<string, PendingAction>();
  private readonly actionByKey = new Map<string, Promise<ActionOutcome>>();
  private readonly checkPresentationLifecycles = new Map<
    string,
    CheckPresentationLifecycle
  >();
  private readonly currentCheckIdByRevision = new Map<string, string>();
  private readonly activeCheckingCheckIdByRevision = new Map<string, string>();
  private readonly checkIdAliases = new Map<string, CheckIdAlias>();
  private readonly actionPresentationAliasesByCommandId = new Map<
    string,
    ActionPresentationAlias
  >();
  private readonly actionAliasCommandIdByActionId = new Map<string, string>();
  private readonly resumableCheckByRevision = new Map<
    string,
    ResumableCheckLifecycle
  >();
  private presentationReplayAlias: PresentationReplayAlias | undefined;
  private presentationValidationCache:
    | {
        readonly documentRevision: string;
        readonly boundariesBySource: Map<string, Set<number>>;
      }
    | undefined;
  private readonly transactionReceipts = new Map<string, HostApplyOutcome>();
  private readonly transactionByAction = new Map<string, string>();
  private readonly retiredRevisions = new Set<string>();
  private session: RefineTransportSession | undefined;
  private latestSnapshot: DocumentSnapshot | undefined;
  private pendingCheck:
    | {
        revision: string;
        intent?: CheckIntent;
        commandId?: string;
        checkId?: string;
      }
    | undefined;
  private currentPresentation: PresentationSnapshot | undefined;
  private appearance = DEFAULT_PRESENTATION_APPEARANCE;
  private interaction = DEFAULT_PRESENTATION_INTERACTION;
  private currentCheckId: string | undefined;
  private currentCheckLineageId: string | undefined;
  private serverEpoch: string | undefined;
  private presentationRevision = 0;
  private checkGeneration = 0;
  private presentationRequest = 0;
  private presentationTail = Promise.resolve();
  private opened = false;
  private applyLeaseActionId: string | undefined;
  private queuedSnapshotDuringApply: DocumentSnapshot | undefined;
  private observationCycle: HostObservationCycle | undefined;
  private observationRestart: Deferred<void> | undefined;
  private closeDocumentSent = false;

  constructor(
    private readonly host: WritingHost,
    private readonly enginePort: WritingCheckEnginePort,
    signal: AbortSignal,
    private readonly reconnectDelayMs: number,
  ) {
    if (signal.aborted) {
      this.lifecycle.abort(signal.reason);
    } else {
      signal.addEventListener("abort", () => this.lifecycle.abort(signal.reason), {
        once: true,
      });
    }
  }

  async start(): Promise<void> {
    const observations = this.openHostObservation();
    this.observationCycle = observations;
    let failure: unknown;
    let observationTask: Promise<void> | undefined;
    try {
      const first = await observations.iterator.next();
      if (first.done || first.value.type !== "snapshot") {
        throw new Error("WritingHost must emit a current snapshot first");
      }
      await this.acceptSnapshot(first.value.snapshot);

      observationTask = this.pumpObservations(observations);
      void observationTask.then(
        async () => {
          if (!this.lifecycle.signal.aborted) {
            await this.closeCurrentDocument();
          }
          this.lifecycle.abort();
        },
        (error: unknown) => {
          failure = error;
          this.lifecycle.abort(error);
        },
      );

      while (!this.lifecycle.signal.aborted) {
        let connected: RefineTransportSession | undefined;
        try {
          connected = await this.enginePort.connect(this.lifecycle.signal, {
            runId: this.runId,
          });
          if (
            this.serverEpoch !== undefined &&
            (this.serverEpoch !== connected.serverEpoch || !connected.runResumed)
          ) {
            await this.abandonUnacknowledgedReceipts();
            this.checkPresentationLifecycles.clear();
            this.currentCheckIdByRevision.clear();
            this.activeCheckingCheckIdByRevision.clear();
            this.resumableCheckByRevision.clear();
            this.checkIdAliases.clear();
            this.actionPresentationAliasesByCommandId.clear();
            this.actionAliasCommandIdByActionId.clear();
            this.presentationReplayAlias = undefined;
            this.currentCheckId = undefined;
            this.currentCheckLineageId = undefined;
            if (this.pendingCheck) {
              delete this.pendingCheck.checkId;
            }
          }
          this.serverEpoch = connected.serverEpoch;
          this.session = connected;
          this.closeDocumentSent = false;
          this.opened = false;
          await this.publishPending();
          await this.openLatestSnapshot();
          await this.pumpEvents(connected);
        } catch (error) {
          if (isFatalConnectionError(error)) {
            failure ??= error;
            this.lifecycle.abort(error);
          }
        } finally {
          if (this.session === connected) {
            if (this.lifecycle.signal.aborted) {
              await this.closeCurrentDocument();
            }
            this.session = undefined;
            this.closeDocumentSent = false;
            this.opened = false;
            if (this.pendingCheck) {
              delete this.pendingCheck.commandId;
            }
          }
          await connected?.close().catch(() => undefined);
        }

        if (!this.lifecycle.signal.aborted) {
          await this.publishUnavailable("disconnected");
          await abortableDelay(this.reconnectDelayMs, this.lifecycle.signal);
        }
      }
      await observationTask.catch((error: unknown) => {
        failure ??= error;
      });
    } catch (error) {
      failure = error;
    } finally {
      this.lifecycle.abort(failure);
      this.observationCycle?.controller.abort(failure);
      await this.observationCycle?.iterator.return?.().catch(() => undefined);
      this.observationCycle?.detach();
      this.observationCycle = undefined;
      await this.finish(failure);
    }

    if (failure !== undefined && !isAbort(failure)) {
      throw failure;
    }
  }

  private async pumpObservations(
    initial: HostObservationCycle,
  ): Promise<void> {
    let observations = initial;
    while (true) {
      while (!this.lifecycle.signal.aborted) {
        const next = await observations.iterator.next();
        if (next.done) {
          break;
        }
        if (next.value.type === "snapshot") {
          await this.acceptSnapshot(next.value.snapshot);
        } else {
          await this.acceptCheckRequest(next.value.revision, next.value.intent);
        }
      }

      await observations.iterator.return?.().catch(() => undefined);
      observations.detach();
      if (this.observationCycle === observations) {
        this.observationCycle = undefined;
      }

      const restart = this.observationRestart;
      if (!restart || this.lifecycle.signal.aborted) {
        return;
      }
      this.observationRestart = undefined;

      observations = this.openHostObservation();
      this.observationCycle = observations;
      try {
        const first = await observations.iterator.next();
        if (first.done || first.value.type !== "snapshot") {
          throw new Error("WritingHost must emit a current snapshot after restart");
        }
        await this.acceptSnapshot(first.value.snapshot);
        restart.resolve(undefined);
      } catch (error) {
        restart.reject(error);
        throw error;
      }
    }
  }

  private openHostObservation(): HostObservationCycle {
    const controller = new AbortController();
    const abort = (): void => controller.abort(this.lifecycle.signal.reason);
    if (this.lifecycle.signal.aborted) {
      abort();
    } else {
      this.lifecycle.signal.addEventListener("abort", abort, { once: true });
    }
    return {
      controller,
      iterator: this.host.observe(controller.signal)[Symbol.asyncIterator](),
      detach: () => this.lifecycle.signal.removeEventListener("abort", abort),
    };
  }

  private restartHostObservation(): Promise<void> {
    if (this.lifecycle.signal.aborted) {
      return Promise.resolve();
    }
    if (!this.observationRestart) {
      this.observationRestart = new Deferred<void>();
      this.observationCycle?.controller.abort(
        new DOMException("Restarting host observation", "AbortError"),
      );
    }
    return this.observationRestart.promise;
  }

  private async pumpEvents(session: RefineTransportSession): Promise<void> {
    const readerController = new AbortController();
    const iterator = session.events(readerController.signal)[Symbol.asyncIterator]();
    const bufferedEvents = new AsyncQueue<ServerEventEnvelope>(
      MAX_BUFFERED_ENGINE_EVENTS,
      coalesceQueuedPresentation,
    );
    void this.readEngineEvents(
      iterator,
      bufferedEvents,
      readerController.signal,
    );
    let stop: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const abort = (): void => {
      readerController.abort(this.lifecycle.signal.reason);
      stop?.();
    };
    if (this.lifecycle.signal.aborted) {
      abort();
      return;
    }
    this.lifecycle.signal.addEventListener("abort", abort, { once: true });
    try {
      while (!this.lifecycle.signal.aborted) {
        const next = await Promise.race([
          bufferedEvents.next().then((result) => ({ type: "event" as const, result })),
          aborted.then(() => ({ type: "aborted" as const })),
        ]);
        if (
          this.lifecycle.signal.aborted ||
          next.type === "aborted" ||
          next.result.done
        ) {
          return;
        }
        await this.acceptEngineEvent(next.result.value);
      }
    } finally {
      this.lifecycle.signal.removeEventListener("abort", abort);
      readerController.abort(this.lifecycle.signal.reason);
      bufferedEvents.close();
      // Some event sources cannot finish `return()` until an outstanding
      // `next()` settles. Session closure wakes them after this pump returns.
      void iterator.return?.().catch(() => undefined);
    }
  }

  private async readEngineEvents(
    iterator: AsyncIterator<ServerEventEnvelope>,
    bufferedEvents: AsyncQueue<ServerEventEnvelope>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      while (!signal.aborted) {
        const next = await iterator.next();
        if (next.done) {
          return;
        }
        const envelope = this.canonicalizePresentationCheckIdentity(
          next.value,
        );
        if (!this.validatePresentationLifecycle(envelope)) {
          continue;
        }
        // Overflow closes the queue and the connection is abandoned. Events
        // that can mutate state are never dropped to make room.
        bufferedEvents.push(envelope);
      }
    } catch (error) {
      bufferedEvents.fail(error);
    } finally {
      bufferedEvents.close();
    }
  }

  private canonicalizePresentationCheckIdentity(
    envelope: ServerEventEnvelope,
  ): ServerEventEnvelope {
    const event = envelope.event;
    if (event.type !== "presentationContentReplaced") {
      return envelope;
    }

    const replayAlias = this.presentationReplayAlias;
    const isReconnectReplay =
      replayAlias !== undefined &&
      envelope.causeCommandId === replayAlias.causeCommandId;
    if (isReconnectReplay) {
      this.presentationReplayAlias = undefined;
    }

    if (isReconnectReplay && replayAlias) {
      const replayBindsActiveCheck =
        event.content.documentRevision === replayAlias.documentRevision &&
        this.isLiveOrResumableCheck(
          replayAlias.documentRevision,
          replayAlias.checkId,
        );
      if (replayBindsActiveCheck && event.content.status === "checking") {
        if (event.checkId !== replayAlias.checkId) {
          this.checkIdAliases.set(event.checkId, {
            documentRevision: replayAlias.documentRevision,
            canonicalCheckId: replayAlias.checkId,
            bindsActiveCheckLifecycle: true,
          });
        }
        return this.rewritePresentationCheckId(
          envelope,
          replayAlias.checkId,
        );
      }
      if (
        replayBindsActiveCheck &&
        event.content.status === "complete"
      ) {
        if (event.checkId !== replayAlias.checkId) {
          this.checkIdAliases.set(event.checkId, {
            documentRevision: replayAlias.documentRevision,
            canonicalCheckId: replayAlias.checkId,
            bindsActiveCheckLifecycle: true,
          });
        }
        return this.preserveResumableCheckAcrossTerminal(
          envelope,
          replayAlias.checkId,
        );
      }
      if (replayBindsActiveCheck && event.content.status === "unavailable") {
        if (event.checkId !== replayAlias.checkId) {
          this.checkIdAliases.set(event.checkId, {
            documentRevision: replayAlias.documentRevision,
            canonicalCheckId: replayAlias.checkId,
            bindsActiveCheckLifecycle: true,
          });
        }
        return this.rewritePresentationCheckId(
          envelope,
          replayAlias.checkId,
        );
      }
      // A pending replay represents a newly scheduled check, while a replay
      // that no longer matches the retained lifecycle must establish its own
      // identity. Consume the one-shot reconnect alias without rewriting it.
      if (
        event.content.status === "pending" ||
        event.content.status === "unavailable"
      ) {
        this.clearResumableCheck(event.content.documentRevision);
      }
      return envelope;
    }

    const actionAlias =
      envelope.causeCommandId === undefined
        ? undefined
        : this.actionPresentationAliasesByCommandId.get(
            envelope.causeCommandId,
          );
    if (
      actionAlias?.documentRevision === event.content.documentRevision
    ) {
      if (event.content.status === "pending") {
        this.clearResumableCheck(event.content.documentRevision);
        return envelope;
      }
      if (event.checkId !== actionAlias.canonicalCheckId) {
        this.checkIdAliases.set(event.checkId, {
          documentRevision: actionAlias.documentRevision,
          canonicalCheckId: actionAlias.canonicalCheckId,
          bindsActiveCheckLifecycle:
            actionAlias.bindsActiveCheckLifecycle,
        });
      }
      if (
        actionAlias.bindsActiveCheckLifecycle &&
        event.content.status === "complete" &&
        this.isLiveOrResumableCheck(
          event.content.documentRevision,
          actionAlias.canonicalCheckId,
        )
      ) {
        return this.preserveResumableCheckAcrossTerminal(
          envelope,
          actionAlias.canonicalCheckId,
        );
      }
      return this.rewritePresentationCheckId(
        envelope,
        actionAlias.canonicalCheckId,
      );
    }

    const knownAlias = this.checkIdAliases.get(event.checkId);
    if (
      knownAlias?.documentRevision === event.content.documentRevision
    ) {
      if (
        knownAlias.bindsActiveCheckLifecycle &&
        event.content.status === "complete" &&
        this.isLiveOrResumableCheck(
          event.content.documentRevision,
          knownAlias.canonicalCheckId,
        )
      ) {
        return this.preserveResumableCheckAcrossTerminal(
          envelope,
          knownAlias.canonicalCheckId,
        );
      }
      if (event.content.status === "pending") {
        this.clearResumableCheck(event.content.documentRevision);
        return envelope;
      }
      return this.rewritePresentationCheckId(
        envelope,
        knownAlias.canonicalCheckId,
      );
    }

    const lifecycle = this.checkPresentationLifecycles.get(event.checkId);
    const currentCheckId = this.currentCheckIdByRevision.get(
      event.content.documentRevision,
    );
    const resumable = this.resumableCheckByRevision.get(
      event.content.documentRevision,
    );
    const isCurrentOrResumableCheck =
      currentCheckId === event.checkId ||
      (resumable?.checkId === event.checkId &&
        resumable.terminalOwnerCheckId === currentCheckId);
    const isRematerializationOfActiveCheck =
      event.content.status === "complete" &&
      isCurrentOrResumableCheck &&
      this.activeCheckingCheckIdByRevision.get(
        event.content.documentRevision,
      ) === event.checkId &&
      lifecycle?.originCauseCommandId !== undefined &&
      envelope.causeCommandId !== lifecycle.originCauseCommandId;
    return isRematerializationOfActiveCheck
      ? this.preserveResumableCheckAcrossTerminal(envelope, event.checkId)
      : this.clearResumableForAuthoritativePresentation(envelope);
  }

  private rewritePresentationCheckId(
    envelope: ServerEventEnvelope,
    canonicalCheckId: string,
  ): ServerEventEnvelope {
    const event = envelope.event;
    if (event.type !== "presentationContentReplaced") {
      return envelope;
    }
    return {
      ...envelope,
      event: { ...event, checkId: canonicalCheckId },
    };
  }

  private preserveResumableCheckAcrossTerminal(
    envelope: ServerEventEnvelope,
    resumableCheckId: string,
  ): ServerEventEnvelope {
    const event = envelope.event;
    if (event.type !== "presentationContentReplaced") {
      return envelope;
    }
    const terminalOwnerCheckId =
      event.checkId === resumableCheckId
        ? `rematerialized-${globalThis.crypto.randomUUID()}`
        : event.checkId;
    this.resumableCheckByRevision.set(event.content.documentRevision, {
      checkId: resumableCheckId,
      terminalOwnerCheckId,
    });
    return this.rewritePresentationCheckId(
      envelope,
      terminalOwnerCheckId,
    );
  }

  private clearResumableForAuthoritativePresentation(
    envelope: ServerEventEnvelope,
  ): ServerEventEnvelope {
    const event = envelope.event;
    if (
      event.type === "presentationContentReplaced" &&
      event.content.status === "pending"
    ) {
      this.clearResumableCheck(event.content.documentRevision);
    } else if (
      event.type === "presentationContentReplaced" &&
      event.content.status === "unavailable"
    ) {
      const resumable = this.resumableCheckByRevision.get(
        event.content.documentRevision,
      );
      if (resumable?.checkId !== event.checkId) {
        this.clearResumableCheck(event.content.documentRevision);
      }
    }
    return envelope;
  }

  private isLiveOrResumableCheck(
    documentRevision: string,
    checkId: string,
  ): boolean {
    if (
      this.activeCheckingCheckIdByRevision.get(documentRevision) !== checkId
    ) {
      return false;
    }
    const currentCheckId = this.currentCheckIdByRevision.get(documentRevision);
    if (currentCheckId === checkId) {
      return true;
    }
    const resumable = this.resumableCheckByRevision.get(documentRevision);
    return (
      resumable?.checkId === checkId &&
      resumable.terminalOwnerCheckId === currentCheckId
    );
  }

  private clearResumableCheck(documentRevision: string): void {
    const resumable = this.resumableCheckByRevision.get(documentRevision);
    if (!resumable) {
      return;
    }
    this.resumableCheckByRevision.delete(documentRevision);
    if (
      this.activeCheckingCheckIdByRevision.get(documentRevision) ===
      resumable.checkId
    ) {
      this.activeCheckingCheckIdByRevision.delete(documentRevision);
    }
  }

  private validatePresentationLifecycle(envelope: ServerEventEnvelope): boolean {
    const event = envelope.event;
    if (event.type !== "presentationContentReplaced") {
      return true;
    }

    const { content } = event;
    validateCheckingProgress(content);
    const previousCurrentCheckId = this.currentCheckIdByRevision.get(
      content.documentRevision,
    );
    let lifecycle = this.checkPresentationLifecycles.get(event.checkId);
    const lifecycleWasKnown = lifecycle !== undefined;
    if (!lifecycle) {
      lifecycle = {
        documentRevision: content.documentRevision,
        checkingStarted: false,
        completed: false,
        closed: false,
        originCauseCommandId: undefined,
      };
      this.checkPresentationLifecycles.set(event.checkId, lifecycle);
    } else if (lifecycle.documentRevision !== content.documentRevision) {
      throw new FatalEngineError(
        "Refine reused a check ID for a different document revision",
      );
    }

    if (previousCurrentCheckId === undefined) {
      this.currentCheckIdByRevision.set(
        content.documentRevision,
        event.checkId,
      );
    } else if (previousCurrentCheckId !== event.checkId) {
      const resumable = this.resumableCheckByRevision.get(
        content.documentRevision,
      );
      if (
        lifecycleWasKnown &&
        resumable?.checkId === event.checkId &&
        resumable.terminalOwnerCheckId === previousCurrentCheckId
      ) {
        this.currentCheckIdByRevision.set(
          content.documentRevision,
          event.checkId,
        );
        this.resumableCheckByRevision.delete(content.documentRevision);
      } else if (!lifecycleWasKnown) {
        if (
          resumable !== undefined &&
          resumable.terminalOwnerCheckId !== event.checkId
        ) {
          this.clearResumableCheck(content.documentRevision);
        }
        this.currentCheckIdByRevision.set(
          content.documentRevision,
          event.checkId,
        );
      } else {
        return false;
      }
    }

    if (lifecycle.closed) {
      if (content.status !== "closed") {
        throw new FatalEngineError(
          "Refine regressed a check after its terminal presentation",
        );
      }
      return true;
    }

    if (
      lifecycle.completed &&
      content.status !== "complete" &&
      content.status !== "unavailable"
    ) {
      throw new FatalEngineError(
        "Refine regressed a check after its terminal presentation",
      );
    }

    if (content.status === "checking") {
      if (!lifecycle.checkingStarted) {
        lifecycle.originCauseCommandId = envelope.causeCommandId;
      }
      lifecycle.checkingStarted = true;
      if (content.progress === undefined) {
        if (lifecycle.progress !== undefined) {
          throw new FatalEngineError(
            "Refine removed determinate progress from an active check",
          );
        }
        this.activeCheckingCheckIdByRevision.set(
          content.documentRevision,
          event.checkId,
        );
        return true;
      }
      if (
        lifecycle.progress !== undefined &&
        lifecycle.progress.totalUnitCount !== content.progress.totalUnitCount
      ) {
        throw new FatalEngineError(
          "Refine changed the total progress count for an active check",
        );
      }
      if (
        lifecycle.progress !== undefined &&
        lifecycle.progress.completedUnitCount >
          content.progress.completedUnitCount
      ) {
        throw new FatalEngineError(
          "Refine decreased completed progress for an active check",
        );
      }
      lifecycle.progress = content.progress;
      this.activeCheckingCheckIdByRevision.set(
        content.documentRevision,
        event.checkId,
      );
      return true;
    }

    if (content.status === "pending" && lifecycle.checkingStarted) {
      throw new FatalEngineError("Refine returned an active check to pending");
    }

    if (
      content.status !== "unavailable" &&
      this.activeCheckingCheckIdByRevision.get(content.documentRevision) ===
      event.checkId
    ) {
      this.activeCheckingCheckIdByRevision.delete(content.documentRevision);
    }

    if (content.status === "complete") {
      lifecycle.completed = true;
    } else if (content.status === "closed") {
      lifecycle.closed = true;
    }
    return true;
  }

  private async acceptSnapshot(snapshot: DocumentSnapshot): Promise<void> {
    this.verifySnapshot(snapshot);
    if (this.latestSnapshot?.revision === snapshot.revision) {
      return;
    }

    this.advanceAuthoritativeSnapshot(snapshot);
    this.pendingCheck = undefined;
    this.currentCheckId = undefined;
    this.currentCheckLineageId = undefined;
    this.invalidateActions(
      { status: "stale" },
      (pending) => pending.id === this.applyLeaseActionId,
    );
    await this.publish({
      documentRevision: snapshot.revision,
      presentationRevision: this.nextPresentationRevision(),
      checkGeneration: this.checkGeneration,
      appearance: this.appearance,
      interaction: this.interaction,
      state: { type: "pending" },
      suggestions: [],
    });

    if (this.applyLeaseActionId) {
      this.queuedSnapshotDuringApply = snapshot;
      return;
    }
    if (this.session && this.opened) {
      await this.send({ type: "replaceDocument", snapshot });
    }
  }

  private async acceptCheckRequest(
    revision: string,
    intent: CheckIntent | undefined,
  ): Promise<void> {
    if (revision !== this.latestSnapshot?.revision) {
      return;
    }
    this.pendingCheck = intent === undefined ? { revision } : { revision, intent };
    if (this.session && this.opened) {
      await this.sendPendingCheck();
    }
  }

  private async openLatestSnapshot(): Promise<void> {
    if (!this.session || !this.latestSnapshot) {
      return;
    }

    // A proven host mutation advances latestSnapshot before its receipt is
    // acknowledged. On a same-epoch reconnect, restore that receipt first so
    // Refine advances the retained run before seeing the newer snapshot.
    for (const [transactionId, outcome] of this.transactionReceipts) {
      const receipt = await this.send({ type: "completeApply", transactionId, outcome });
      if (!receipt) {
        throw new Error("Unable to restore pending Apply receipt");
      }
    }

    const openCommandId = globalThis.crypto.randomUUID();
    const documentRevision = this.latestSnapshot.revision;
    const resumableCheckId = this.resumableCheckByRevision.get(
      documentRevision,
    )?.checkId;
    const activeCheckId = this.activeCheckingCheckIdByRevision.get(
      documentRevision,
    );
    const retainedCheckId =
      resumableCheckId !== undefined &&
      this.isLiveOrResumableCheck(documentRevision, resumableCheckId)
        ? resumableCheckId
        : activeCheckId;
    this.presentationReplayAlias =
      retainedCheckId !== undefined &&
      this.isLiveOrResumableCheck(documentRevision, retainedCheckId)
        ? {
            causeCommandId: openCommandId,
            documentRevision,
            checkId: retainedCheckId,
          }
        : undefined;
    const opened = await this.send(
      { type: "openDocument", snapshot: this.latestSnapshot },
      openCommandId,
    );
    if (!opened) {
      this.presentationReplayAlias = undefined;
      throw new Error("Unable to open document on Refine engine connection");
    }
    this.opened = true;
    await this.sendPendingCheck();
  }

  private async sendPendingCheck(): Promise<void> {
    const pending = this.pendingCheck;
    if (
      !pending ||
      pending.commandId !== undefined ||
      !this.session ||
      pending.revision !== this.latestSnapshot?.revision
    ) {
      return;
    }
    const previousCheckId = pending.checkId;
    delete pending.checkId;
    const commandId = globalThis.crypto.randomUUID();
    pending.commandId = commandId;
    const sent = await this.send(
      pending.intent === undefined
        ? { type: "requestCheck", revision: pending.revision }
        : { type: "requestCheck", revision: pending.revision, intent: pending.intent },
      commandId,
    );
    if (!sent && this.pendingCheck === pending) {
      delete pending.commandId;
      if (previousCheckId !== undefined) {
        pending.checkId = previousCheckId;
      }
    }
  }

  private async acceptEngineEvent(envelope: ServerEventEnvelope): Promise<void> {
    const event = envelope.event;
    switch (event.type) {
      case "documentAccepted":
        return;
      case "resyncRequired":
        if (event.reason === "documentNotOpen") {
          this.opened = false;
          await this.openLatestSnapshot();
          return;
        }
        throw new FatalEngineError(
          `Refine rejected the authoritative document: ${event.reason}`,
        );
      case "presentationContentReplaced":
        await this.acceptPresentation(
          event.checkId,
          event.content,
          envelope.causeCommandId,
        );
        return;
      case "applyRequested":
        await this.completeHostApply(
          event.actionId,
          event.transactionId,
          event.request,
        );
        return;
      case "explanationReplaced": {
        const pending = this.pendingActions.get(event.actionId);
        pending?.explanation?.push(event.update);
        if (
          event.update.status === "completed" ||
          event.update.status === "stale" ||
          event.update.status === "unavailable"
        ) {
          pending?.explanation?.close();
        }
        return;
      }
      case "actionCompleted":
        await this.completeAction(event.actionId, { status: "completed" });
        return;
      case "actionRejected":
        await this.completeAction(
          event.actionId,
          actionOutcomeForRejection(event.reason),
        );
        return;
      case "fault":
        if (event.fatal) {
          throw new FatalEngineError(`Refine engine fault: ${event.code}`);
        }
        if (event.code === "engineUnavailable") {
          await this.publishUnavailable("engineUnavailable");
        }
        return;
    }
  }

  private async acceptPresentation(
    checkId: string,
    content: PresentationContent,
    causeCommandId: string | undefined,
  ): Promise<void> {
    const latestSnapshot = this.latestSnapshot;
    if (!latestSnapshot || content.documentRevision !== latestSnapshot.revision) {
      return;
    }
    if (
      this.currentCheckIdByRevision.get(content.documentRevision) !== checkId
    ) {
      return;
    }
    const causedActionId =
      causeCommandId === undefined
        ? undefined
        : this.actionPresentationAliasesByCommandId.get(causeCommandId)
            ?.actionId;
    const checkIdChanged = this.currentCheckId !== checkId;
    if (this.currentCheckId !== undefined && checkIdChanged) {
      this.invalidateActions(
        { status: "stale" },
        (pending) =>
          pending.id === this.applyLeaseActionId ||
          pending.id === causedActionId,
      );
    }
    const resumableCheck = this.resumableCheckByRevision.get(
      content.documentRevision,
    );
    const checkLineageId =
      resumableCheck?.terminalOwnerCheckId === checkId
        ? resumableCheck.checkId
        : checkId;
    if (this.currentCheckLineageId !== checkLineageId) {
      this.checkGeneration += 1;
    }
    this.currentCheckId = checkId;
    this.currentCheckLineageId = checkLineageId;
    const pendingCheck = this.pendingCheck;
    if (
      pendingCheck?.commandId !== undefined &&
      pendingCheck.commandId === causeCommandId
    ) {
      if (
        pendingCheck.checkId !== undefined &&
        pendingCheck.checkId !== checkId
      ) {
        throw new FatalEngineError(
          "Refine attributed one check request to multiple check IDs",
        );
      }
      pendingCheck.checkId = checkId;
    }
    if (
      (content.status === "complete" || content.status === "unavailable") &&
      pendingCheck?.checkId === checkId
    ) {
      this.pendingCheck = undefined;
    }
    validatePresentationContent(
      content,
      latestSnapshot,
      this.presentationBoundaries(latestSnapshot),
    );
    this.appearance = content.appearance;
    this.interaction = content.interaction;
    const snapshot: PresentationSnapshot = {
      documentRevision: content.documentRevision,
      presentationRevision: this.nextPresentationRevision(),
      checkGeneration: this.checkGeneration,
      appearance: this.appearance,
      interaction: this.interaction,
      state: presentationState(content),
      suggestions: this.disablePendingActions(content.suggestions),
    };
    await this.publish(snapshot);
  }

  private actionsFor(snapshot: PresentationSnapshot): SuggestionActions {
    return {
      apply: (suggestionId) => this.performAction(snapshot, suggestionId, "apply"),
      dismiss: (suggestionId) => this.performAction(snapshot, suggestionId, "dismiss"),
      explain: (suggestionId) => this.explain(snapshot, suggestionId),
      report: (suggestionId) => this.performAction(snapshot, suggestionId, "report"),
    };
  }

  private performAction(
    presentation: PresentationSnapshot,
    suggestionId: string,
    kind: Exclude<SuggestionActionKind, "explain">,
  ): Promise<ActionOutcome> {
    const suggestion = liveSuggestion(this.currentPresentation, presentation, suggestionId, kind);
    if (!suggestion || !this.session) {
      return Promise.resolve({ status: "stale" });
    }
    const key = `${presentation.presentationRevision}:${suggestionId}:${kind}`;
    const existing = this.actionByKey.get(key);
    if (existing) {
      return existing;
    }

    const operation = this.beginAction(presentation, suggestionId, kind, key);
    this.actionByKey.set(key, operation);
    const removeOperation = (): void => {
      if (this.actionByKey.get(key) === operation) {
        this.actionByKey.delete(key);
      }
    };
    void operation.then(removeOperation, removeOperation);
    return operation;
  }

  private async beginAction(
    presentation: PresentationSnapshot,
    suggestionId: string,
    kind: Exclude<SuggestionActionKind, "explain">,
    key: string,
  ): Promise<ActionOutcome> {
    if (kind !== "apply") {
      const validation = await this.host.validateRevision(presentation.documentRevision);
      if (validation.status === "stale") {
        await this.acceptSnapshot(validation.snapshot);
        return { status: "stale" };
      }
      if (validation.status === "unavailable") {
        return { status: "unavailable", reason: "validationUnavailable" };
      }
    }
    if (
      !this.session ||
      !liveSuggestion(this.currentPresentation, presentation, suggestionId, kind)
    ) {
      return { status: "stale" };
    }

    const id = globalThis.crypto.randomUUID();
    const result = new Deferred<ActionOutcome>();
    const pending: PendingAction = {
      id,
      key,
      kind,
      suggestionId,
      basePresentation: presentation,
      result,
    };
    this.pendingActions.set(id, pending);
    if (kind === "apply" || kind === "dismiss") {
      await this.disableAction(presentation, suggestionId, kind);
    }
    const actionCommandId =
      kind === "dismiss" ? globalThis.crypto.randomUUID() : undefined;
    const presentationOwnerCheckId = this.currentCheckIdByRevision.get(
      presentation.documentRevision,
    );
    const resumableCheck = this.resumableCheckByRevision.get(
      presentation.documentRevision,
    );
    const canonicalCheckId =
      resumableCheck !== undefined &&
      resumableCheck.terminalOwnerCheckId === presentationOwnerCheckId
        ? resumableCheck.checkId
        : presentationOwnerCheckId;
    if (
      actionCommandId !== undefined &&
      canonicalCheckId !== undefined &&
      this.currentCheckId === presentationOwnerCheckId
    ) {
      this.actionPresentationAliasesByCommandId.set(actionCommandId, {
        actionId: id,
        documentRevision: presentation.documentRevision,
        canonicalCheckId,
        bindsActiveCheckLifecycle:
          this.activeCheckingCheckIdByRevision.get(
            presentation.documentRevision,
          ) === canonicalCheckId,
      });
      this.actionAliasCommandIdByActionId.set(id, actionCommandId);
    }
    try {
      const sent = await this.send(
        {
          type: "performAction",
          actionId: id,
          kind,
          suggestion: {
            id: suggestionId,
            documentRevision: presentation.documentRevision,
          },
        },
        actionCommandId,
      );
      if (!sent) {
        await this.completeAction(id, {
          status: "unavailable",
          reason: "disconnected",
        });
      }
    } catch {
      await this.completeAction(id, {
        status: "unavailable",
        reason: "disconnected",
      });
    }
    return result.promise;
  }

  private explain(
    presentation: PresentationSnapshot,
    suggestionId: string,
  ): AsyncIterableIterator<ExplanationUpdate> {
    return new ExplanationActionStream(async (stream) => {
      const suggestion = liveSuggestion(
        this.currentPresentation,
        presentation,
        suggestionId,
        "explain",
      );
      if (!suggestion || !this.session) {
        stream.finishWith({ status: "stale" });
        return;
      }
      const validation = await this.host.validateRevision(
        presentation.documentRevision,
      );
      if (validation.status !== "current") {
        if (validation.status === "stale") {
          await this.acceptSnapshot(validation.snapshot);
        }
        if (!stream.isCancelled) {
          stream.finishWith(
            validation.status === "stale"
              ? { status: "stale" }
              : { status: "unavailable", reason: "validationUnavailable" },
          );
        }
        return;
      }

      if (stream.isCancelled) {
        return;
      }
      if (
        !this.session ||
        !liveSuggestion(this.currentPresentation, presentation, suggestionId, "explain")
      ) {
        stream.finishWith({ status: "stale" });
        return;
      }

      const id = globalThis.crypto.randomUUID();
      const pending: PendingAction = {
        id,
        key: `${presentation.presentationRevision}:${suggestionId}:explain`,
        kind: "explain",
        suggestionId,
        basePresentation: presentation,
        result: new Deferred<ActionOutcome>(),
        explanation: stream.queue,
      };
      const removePending = (): void => {
        if (this.pendingActions.get(id)?.explanation === stream.queue) {
          this.pendingActions.delete(id);
          this.actionByKey.delete(pending.key);
        }
      };
      this.pendingActions.set(id, pending);
      stream.setCleanup(removePending);
      if (stream.isCancelled) {
        return;
      }

      const sent = await this.send({
        type: "performAction",
        actionId: id,
        kind: "explain",
        suggestion: {
          id: suggestionId,
          documentRevision: presentation.documentRevision,
        },
      });
      if (!sent && !stream.isCancelled) {
        removePending();
        stream.finishWith({ status: "unavailable", reason: "disconnected" });
      }
    });
  }

  private async disableAction(
    presentation: PresentationSnapshot,
    suggestionId: string,
    kind: SuggestionActionKind,
  ): Promise<void> {
    if (this.currentPresentation?.presentationRevision !== presentation.presentationRevision) {
      return;
    }
    const disabled: PresentationSnapshot = {
      ...presentation,
      presentationRevision: this.nextPresentationRevision(),
      suggestions: presentation.suggestions.map((suggestion) =>
        suggestion.id === suggestionId
          ? {
              ...suggestion,
              availableActions: suggestion.availableActions.filter((action) => action !== kind),
            }
          : suggestion,
      ),
    };
    await this.publish(disabled);
  }

  private async completeHostApply(
    actionId: string,
    transactionId: string,
    request: import("./types").HostApplyRequest,
  ): Promise<void> {
    if (!this.session) {
      return;
    }
    const duplicate = this.transactionReceipts.get(transactionId);
    if (duplicate) {
      const receipt = await this.send({
        type: "completeApply",
        transactionId,
        outcome: duplicate,
      });
      if (!receipt) {
        throw new Error("Unable to resend Apply receipt");
      }
      return;
    }

    const pending = this.pendingActions.get(actionId);
    if (!pending || pending.kind !== "apply") {
      const snapshot = this.latestSnapshot;
      if (!snapshot) {
        throw new FatalEngineError("Engine requested Apply before a document was opened");
      }
      const outcome: HostApplyOutcome = {
        status: "rejected",
        reason: "staleRevision",
        snapshot,
      };
      this.transactionReceipts.set(transactionId, outcome);
      this.transactionByAction.set(actionId, transactionId);
      const receipt = await this.send({ type: "completeApply", transactionId, outcome });
      if (!receipt) {
        throw new Error("Unable to send stale Apply receipt");
      }
      return;
    }
    if (pending.transactionId && pending.transactionId !== transactionId) {
      throw new FatalEngineError("Engine changed transaction ID for an Apply action");
    }
    pending.transactionId = transactionId;
    this.transactionByAction.set(actionId, transactionId);
    this.applyLeaseActionId = actionId;
    let outcomeSnapshot: DocumentSnapshot | undefined;
    try {
      let outcome: HostApplyOutcome;
      try {
        outcome = await this.host.apply(request);
      } catch (error) {
        throw new FatalHostError("WritingHost.apply failed outside its outcome contract", {
          cause: error,
        });
      }
      this.transactionReceipts.set(transactionId, outcome);
      outcomeSnapshot = snapshotFromOutcome(outcome);
      const queuedSnapshot = this.queuedSnapshotDuringApply;
      const queuedAfterOutcome =
        queuedSnapshot !== undefined &&
        queuedSnapshot.revision !== outcomeSnapshot?.revision;
      if (
        outcomeSnapshot &&
        !queuedAfterOutcome &&
        outcomeSnapshot.revision !== this.latestSnapshot?.revision
      ) {
        this.verifySnapshot(outcomeSnapshot);
        this.advanceAuthoritativeSnapshot(outcomeSnapshot);
        this.pendingCheck = undefined;
        this.currentCheckId = undefined;
        this.currentCheckLineageId = undefined;
        this.invalidateActions(
          { status: "stale" },
          (candidate) => candidate.id === actionId,
        );
        await this.publish({
          documentRevision: outcomeSnapshot.revision,
          presentationRevision: this.nextPresentationRevision(),
          checkGeneration: this.checkGeneration,
          appearance: this.appearance,
          interaction: this.interaction,
          state: { type: "pending" },
          suggestions: [],
        });
      }
      if (outcome.status === "indeterminate") {
        const revision = this.latestSnapshot?.revision;
        if (revision) {
          await this.publish({
            documentRevision: revision,
            presentationRevision: this.nextPresentationRevision(),
            checkGeneration: this.checkGeneration,
            appearance: this.appearance,
            interaction: this.interaction,
            state: { type: "pending" },
            suggestions: [],
          });
        }
      }
      const receipt = await this.send({ type: "completeApply", transactionId, outcome });
      if (!receipt) {
        throw new Error("Unable to send Apply receipt");
      }
      if (outcome.status === "indeterminate" && outcome.snapshot === undefined) {
        await this.restartHostObservation();
      }
    } finally {
      this.applyLeaseActionId = undefined;
      const queued = this.queuedSnapshotDuringApply;
      this.queuedSnapshotDuringApply = undefined;
      if (
        this.session &&
        queued &&
        queued.revision !== outcomeSnapshot?.revision &&
        queued.revision === this.latestSnapshot?.revision
      ) {
        await this.send({ type: "replaceDocument", snapshot: queued });
      }
    }
  }

  private async completeAction(actionId: string, outcome: ActionOutcome): Promise<void> {
    this.clearActionPresentationAlias(actionId);
    const associatedTransaction = this.transactionByAction.get(actionId);
    if (associatedTransaction) {
      this.transactionByAction.delete(actionId);
      this.transactionReceipts.delete(associatedTransaction);
    }
    const pending = this.pendingActions.get(actionId);
    if (!pending) {
      return;
    }
    this.pendingActions.delete(actionId);
    this.actionByKey.delete(pending.key);
    pending.result.resolve(outcome);
    if (outcome.status === "stale") {
      pending.explanation?.push({ status: "stale" });
    } else if (outcome.status === "unavailable") {
      pending.explanation?.push({
        status: "unavailable",
        reason: outcome.reason,
      });
    }
    pending.explanation?.close();
    const currentPresentation = this.currentPresentation;
    if (
      outcome.status === "completed" &&
      pending.kind === "dismiss" &&
      currentPresentation !== undefined &&
      currentPresentation.documentRevision === this.latestSnapshot?.revision
    ) {
      const withoutDismissed: PresentationSnapshot = {
        ...currentPresentation,
        presentationRevision: this.nextPresentationRevision(),
        suggestions: currentPresentation.suggestions.filter(
          (suggestion) => suggestion.id !== pending.suggestionId,
        ),
      };
      await this.publish(withoutDismissed);
      return;
    }
    const presentationForRestore = this.currentPresentation;
    if (
      (pending.kind === "apply" || pending.kind === "dismiss") &&
      outcome.status !== "completed" &&
      outcome.status !== "stale" &&
      !(outcome.status === "unavailable" && outcome.reason === "mutationIndeterminate") &&
      !(outcome.status === "unavailable" && outcome.reason === "disconnected") &&
      presentationForRestore !== undefined &&
      presentationForRestore.documentRevision === this.latestSnapshot?.revision
    ) {
      const restored: PresentationSnapshot = {
        ...presentationForRestore,
        presentationRevision: this.nextPresentationRevision(),
        suggestions: presentationForRestore.suggestions.map((suggestion) =>
          suggestion.id === pending.suggestionId &&
          pending.basePresentation.suggestions
            .find((base) => base.id === pending.suggestionId)
            ?.availableActions.includes(pending.kind)
            ? {
                ...suggestion,
                availableActions: suggestion.availableActions.includes(pending.kind)
                  ? suggestion.availableActions
                  : [...suggestion.availableActions, pending.kind],
              }
            : suggestion,
        ),
      };
      await this.publish(restored);
    }
  }

  private async abandonUnacknowledgedReceipts(): Promise<void> {
    const actionIds = [...this.transactionByAction.keys()];
    for (const actionId of actionIds) {
      await this.completeAction(actionId, {
        status: "unavailable",
        reason: "disconnected",
      });
    }
    this.transactionReceipts.clear();
    this.transactionByAction.clear();
  }

  private invalidateActions(
    outcome: ActionOutcome,
    keep: (pending: PendingAction) => boolean = () => false,
  ): void {
    for (const [actionId, pending] of this.pendingActions) {
      if (keep(pending)) {
        continue;
      }
      this.clearActionPresentationAlias(actionId);
      pending.result.resolve(outcome);
      if (outcome.status === "stale") {
        pending.explanation?.push({ status: "stale" });
      } else if (outcome.status === "unavailable") {
        pending.explanation?.push({ status: "unavailable", reason: outcome.reason });
      }
      pending.explanation?.close();
      this.pendingActions.delete(actionId);
      this.actionByKey.delete(pending.key);
    }
  }

  private clearActionPresentationAlias(actionId: string): void {
    const commandId = this.actionAliasCommandIdByActionId.get(actionId);
    if (commandId === undefined) {
      return;
    }
    this.actionAliasCommandIdByActionId.delete(actionId);
    this.actionPresentationAliasesByCommandId.delete(commandId);
  }

  private publish(snapshot: PresentationSnapshot): Promise<void> {
    const request = this.presentationRequest + 1;
    this.presentationRequest = request;
    this.currentPresentation = snapshot;
    const actions = this.actionsFor(snapshot);
    const operation = this.presentationTail
      .catch(() => undefined)
      .then(async () => {
        if (request !== this.presentationRequest) {
          return;
        }
        try {
          await this.host.present(snapshot, actions);
        } catch (error) {
          throw new FatalHostError("WritingHost.present failed", { cause: error });
        }
      });
    this.presentationTail = operation;
    return operation;
  }

  private publishUnavailable(
    reason: "disconnected" | "engineUnavailable",
  ): Promise<void> {
    const revision = this.latestSnapshot?.revision;
    if (!revision) {
      return Promise.resolve();
    }
    this.invalidateActions(
      { status: "unavailable", reason },
      (pending) => pending.transactionId !== undefined,
    );
    return this.publish({
      documentRevision: revision,
      presentationRevision: this.nextPresentationRevision(),
      checkGeneration: this.checkGeneration,
      appearance: this.appearance,
      interaction: this.interaction,
      state: { type: "unavailable", reason },
      suggestions: [],
    });
  }

  private async finish(failure: unknown): Promise<void> {
    if (this.session) {
      await this.closeCurrentDocument();
      await this.session.close().catch(() => undefined);
    }
    this.invalidateActions({ status: "stale" });
    const revision = this.latestSnapshot?.revision;
    if (revision) {
      if (failure !== undefined && !isAbort(failure)) {
        await this.publishUnavailable("disconnected");
      }
      await this.publish({
        documentRevision: revision,
        presentationRevision: this.nextPresentationRevision(),
        checkGeneration: this.checkGeneration,
        appearance: this.appearance,
        interaction: this.interaction,
        state: { type: "closed" },
        suggestions: [],
      });
      await this.presentationTail.catch(() => undefined);
    }
  }

  private verifySnapshot(snapshot: DocumentSnapshot): void {
    if (snapshot.revision.length === 0) {
      throw new Error("WritingHost emitted an empty revision");
    }
    if (snapshot.sources.length === 0 || snapshot.sources.length > 2) {
      throw new Error("WritingHost must emit between one and two source islands");
    }
    const sourceIds = new Set<string>();
    for (const source of snapshot.sources) {
      if (source.sourceId.length === 0 || sourceIds.has(source.sourceId)) {
        throw new Error("WritingHost source IDs must be nonempty and unique");
      }
      sourceIds.add(source.sourceId);
    }
    const current = this.latestSnapshot;
    if (current?.revision === snapshot.revision) {
      if (!sameSources(current.sources, snapshot.sources)) {
        throw new Error("WritingHost reused a revision for different source content");
      }
      return;
    }
    if (this.retiredRevisions.has(snapshot.revision)) {
      throw new Error("WritingHost reused a retired revision");
    }
    if (current) {
      this.retiredRevisions.add(current.revision);
    }
  }

  private advanceAuthoritativeSnapshot(snapshot: DocumentSnapshot): void {
    this.latestSnapshot = snapshot;
    this.presentationValidationCache = {
      documentRevision: snapshot.revision,
      boundariesBySource: new Map(),
    };
    for (const [checkId, lifecycle] of this.checkPresentationLifecycles) {
      if (lifecycle.documentRevision !== snapshot.revision) {
        this.checkPresentationLifecycles.delete(checkId);
      }
    }
    for (const revision of this.currentCheckIdByRevision.keys()) {
      if (revision !== snapshot.revision) {
        this.currentCheckIdByRevision.delete(revision);
      }
    }
    for (const revision of this.activeCheckingCheckIdByRevision.keys()) {
      if (revision !== snapshot.revision) {
        this.activeCheckingCheckIdByRevision.delete(revision);
      }
    }
    for (const revision of this.resumableCheckByRevision.keys()) {
      if (revision !== snapshot.revision) {
        this.resumableCheckByRevision.delete(revision);
      }
    }
    for (const [checkId, alias] of this.checkIdAliases) {
      if (alias.documentRevision !== snapshot.revision) {
        this.checkIdAliases.delete(checkId);
      }
    }
    if (
      this.presentationReplayAlias?.documentRevision !== snapshot.revision
    ) {
      this.presentationReplayAlias = undefined;
    }
  }

  private presentationBoundaries(
    snapshot: DocumentSnapshot,
  ): Map<string, Set<number>> {
    let cache = this.presentationValidationCache;
    if (!cache || cache.documentRevision !== snapshot.revision) {
      cache = {
        documentRevision: snapshot.revision,
        boundariesBySource: new Map(),
      };
      this.presentationValidationCache = cache;
    }
    return cache.boundariesBySource;
  }

  private nextPresentationRevision(): number {
    this.presentationRevision += 1;
    return this.presentationRevision;
  }

  private publishPending(): Promise<void> {
    const revision = this.latestSnapshot?.revision;
    if (!revision) {
      return Promise.resolve();
    }
    return this.publish({
      documentRevision: revision,
      presentationRevision: this.nextPresentationRevision(),
      checkGeneration: this.checkGeneration,
      appearance: this.appearance,
      interaction: this.interaction,
      state: { type: "pending" },
      suggestions: [],
    });
  }

  private async send(
    command: ClientCommand,
    commandId?: string,
  ): Promise<CommandReceipt | undefined> {
    const session = this.session;
    if (!session) {
      return undefined;
    }
    try {
      return await session.send(command, commandId);
    } catch (error) {
      if (this.session === session) {
        this.session = undefined;
        this.opened = false;
      }
      await session.close().catch(() => undefined);
      if (isFatalEngineConnectionError(error)) {
        throw error;
      }
      return undefined;
    }
  }

  private async closeCurrentDocument(): Promise<void> {
    const session = this.session;
    if (!session || this.closeDocumentSent) {
      return;
    }
    this.closeDocumentSent = true;
    await session.send({ type: "closeDocument" }).catch(() => undefined);
  }

  private disablePendingActions(
    suggestions: readonly PresentedSuggestion[],
  ): readonly PresentedSuggestion[] {
    const disabledBySuggestion = new Map<string, Set<SuggestionActionKind>>();
    for (const pending of this.pendingActions.values()) {
      if (pending.basePresentation.documentRevision !== this.latestSnapshot?.revision) {
        continue;
      }
      const actions = disabledBySuggestion.get(pending.suggestionId) ?? new Set();
      actions.add(pending.kind);
      disabledBySuggestion.set(pending.suggestionId, actions);
    }
    return suggestions.map((suggestion) => {
      const disabled = disabledBySuggestion.get(suggestion.id);
      return disabled
        ? {
            ...suggestion,
            availableActions: suggestion.availableActions.filter(
              (action) => !disabled.has(action),
            ),
          }
        : suggestion;
    });
  }
}

class ExplanationActionStream implements AsyncIterableIterator<ExplanationUpdate> {
  readonly queue = new AsyncQueue<ExplanationUpdate>();

  private readonly cancelled: Promise<IteratorResult<ExplanationUpdate>>;
  private resolveCancellation!: (
    result: IteratorResult<ExplanationUpdate>,
  ) => void;
  private startPromise: Promise<void> | undefined;
  private cleanup: (() => void) | undefined;
  private cancelledLocally = false;
  private ended = false;

  constructor(
    private readonly start: (stream: ExplanationActionStream) => Promise<void>,
  ) {
    this.cancelled = new Promise((resolve) => {
      this.resolveCancellation = resolve;
    });
  }

  get isCancelled(): boolean {
    return this.cancelledLocally;
  }

  next(): Promise<IteratorResult<ExplanationUpdate>> {
    if (this.ended) {
      return Promise.resolve({ done: true, value: undefined });
    }
    const read = this.ensureStarted().then(() => this.readQueue());
    return Promise.race([read, this.cancelled]);
  }

  return(): Promise<IteratorResult<ExplanationUpdate>> {
    const result: IteratorResult<ExplanationUpdate> = {
      done: true,
      value: undefined,
    };
    if (!this.ended) {
      this.cancelledLocally = true;
      this.ended = true;
      this.runCleanup();
      this.queue.close();
      this.resolveCancellation(result);
    }
    return Promise.resolve(result);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<ExplanationUpdate> {
    return this;
  }

  setCleanup(cleanup: () => void): void {
    if (this.ended) {
      cleanup();
      return;
    }
    this.cleanup = cleanup;
  }

  finishWith(update: ExplanationUpdate): void {
    if (this.ended) {
      return;
    }
    this.queue.push(update);
    this.queue.close();
  }

  private ensureStarted(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.start(this).catch((error: unknown) => {
        this.queue.fail(error);
      });
    }
    return this.startPromise;
  }

  private async readQueue(): Promise<IteratorResult<ExplanationUpdate>> {
    try {
      const result = await this.queue.next();
      if (result.done) {
        this.ended = true;
        this.runCleanup();
      }
      return result;
    } catch (error) {
      this.ended = true;
      this.runCleanup();
      throw error;
    }
  }

  private runCleanup(): void {
    const cleanup = this.cleanup;
    this.cleanup = undefined;
    cleanup?.();
  }
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

function liveSuggestion(
  current: PresentationSnapshot | undefined,
  bound: PresentationSnapshot,
  suggestionId: string,
  action: SuggestionActionKind,
): PresentedSuggestion | undefined {
  if (
    current?.presentationRevision !== bound.presentationRevision ||
    current.documentRevision !== bound.documentRevision
  ) {
    return undefined;
  }
  return bound.suggestions.find(
    (suggestion) =>
      suggestion.id === suggestionId && suggestion.availableActions.includes(action),
  );
}

function sameSources(
  left: DocumentSnapshot["sources"],
  right: DocumentSnapshot["sources"],
): boolean {
  return (
    left.length === right.length &&
    left.every((source, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        source.sourceId === candidate.sourceId &&
        source.sourceSyntax === candidate.sourceSyntax &&
        source.text === candidate.text
      );
    })
  );
}

function presentationState(content: PresentationContent): PresentationSnapshot["state"] {
  switch (content.status) {
    case "pending":
      return { type: "pending" };
    case "checking":
      return content.progress === undefined
        ? { type: "checking" }
        : { type: "checking", progress: content.progress };
    case "complete":
      return { type: "complete", coverage: content.coverage ?? "full" };
    case "unavailable":
      return {
        type: "unavailable",
        reason: content.unavailableReason ?? "engineUnavailable",
      };
    case "closed":
      return { type: "closed" };
  }
}

function snapshotFromOutcome(outcome: HostApplyOutcome): DocumentSnapshot | undefined {
  return "snapshot" in outcome ? outcome.snapshot : undefined;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || milliseconds <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function coalesceQueuedPresentation(
  previous: ServerEventEnvelope,
  next: ServerEventEnvelope,
): ServerEventEnvelope | undefined {
  const previousEvent = previous.event;
  const nextEvent = next.event;
  if (
    previousEvent.type !== "presentationContentReplaced" ||
    nextEvent.type !== "presentationContentReplaced" ||
    previous.epoch !== next.epoch ||
    previous.causeCommandId !== next.causeCommandId ||
    previousEvent.checkId !== nextEvent.checkId ||
    previousEvent.content.documentRevision !==
      nextEvent.content.documentRevision ||
    previousEvent.content.status !== "checking" ||
    (nextEvent.content.status !== "checking" &&
      nextEvent.content.status !== "complete")
  ) {
    return undefined;
  }
  return next;
}

function actionOutcomeForRejection(reason: ActionRejectionReason): ActionOutcome {
  switch (reason) {
    case "stale":
      return { status: "stale" };
    case "disconnected":
    case "engineUnavailable":
    case "validationUnavailable":
    case "readOnly":
    case "nonAtomic":
    case "mutationUnavailable":
    case "mutationIndeterminate":
    case "applyNotProven":
    case "reportingUnavailable":
      return { status: "unavailable", reason };
    case "unsupportedAction":
      return { status: "unavailable", reason: "engineUnavailable" };
  }
}

class FatalEngineError extends Error {}

class FatalHostError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FatalHostError";
  }
}

function isFatalConnectionError(error: unknown): boolean {
  return (
    error instanceof FatalEngineError ||
    error instanceof FatalHostError ||
    isFatalEngineConnectionError(error)
  );
}

function validatePresentationContent(
  content: PresentationContent,
  snapshot: DocumentSnapshot,
  boundariesBySource: Map<string, Set<number>>,
): void {
  if (
    (content.status === "pending" ||
      content.status === "unavailable" ||
      content.status === "closed") &&
    content.suggestions.length !== 0
  ) {
    throw new FatalEngineError(`${content.status} presentation contained suggestions`);
  }

  const sources = new Map(snapshot.sources.map((source) => [source.sourceId, source.text]));
  const suggestionIds = new Set<string>();
  for (const suggestion of content.suggestions) {
    if (suggestionIds.has(suggestion.id)) {
      throw new FatalEngineError("Presentation contained a duplicate suggestion ID");
    }
    suggestionIds.add(suggestion.id);
    const text = sources.get(suggestion.sourceId);
    if (text === undefined) {
      throw new FatalEngineError("Presentation referenced an unknown source ID");
    }
    let boundaries = boundariesBySource.get(suggestion.sourceId);
    if (!boundaries) {
      boundaries = graphemeBoundaries(text);
      boundariesBySource.set(suggestion.sourceId, boundaries);
    }
    const activationEnd =
      suggestion.activationRange.location + suggestion.activationRange.length;
    if (
      !Number.isSafeInteger(suggestion.activationRange.location) ||
      !Number.isSafeInteger(suggestion.activationRange.length) ||
      suggestion.activationRange.location < 0 ||
      suggestion.activationRange.length < 0 ||
      !Number.isSafeInteger(activationEnd) ||
      activationEnd > text.length ||
      !boundaries.has(suggestion.activationRange.location) ||
      !boundaries.has(activationEnd)
    ) {
      throw new FatalEngineError("Presentation contained an invalid activation range");
    }
    let previousEnd = 0;
    const insertionAnchors = new Set<number>();
    for (const range of suggestion.highlightRanges) {
      const end = range.location + range.length;
      if (
        range.location < previousEnd ||
        end > text.length ||
        !boundaries.has(range.location) ||
        !boundaries.has(end) ||
        (range.length === 0 && insertionAnchors.has(range.location))
      ) {
        throw new FatalEngineError("Presentation contained an invalid highlight range");
      }
      if (range.length === 0) {
        insertionAnchors.add(range.location);
      }
      previousEnd = end;
    }
  }
}

function validateCheckingProgress(content: PresentationContent): void {
  const progress = content.progress;
  if (progress === undefined) {
    return;
  }
  if (
    content.status !== "checking" ||
    !Number.isSafeInteger(progress.completedUnitCount) ||
    !Number.isSafeInteger(progress.totalUnitCount) ||
    progress.completedUnitCount < 0 ||
    progress.totalUnitCount < 0 ||
    progress.completedUnitCount > progress.totalUnitCount
  ) {
    throw new FatalEngineError("Refine sent malformed checking progress");
  }
}
