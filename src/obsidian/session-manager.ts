import type { EditorView } from "@codemirror/view";

import type {
  CheckIntent,
  PresentationSnapshot,
  RefineIntegration,
} from "../integration/types";
import {
  IncompatibleProtocolError,
  type ProtocolVersion,
} from "../transport/refine-transport";
import { isIncompatibleEngineError } from "./compatibility";
import { ObsidianWritingHost } from "./host";
import type { ExplanationRenderer } from "./presentation";

export type ObsidianSessionState =
  | { readonly type: "inactive" }
  | { readonly type: "starting" }
  | { readonly type: "presented"; readonly snapshot: PresentationSnapshot }
  | {
      readonly type: "failed";
      readonly reason: "unavailable";
    }
  | {
      readonly type: "failed";
      readonly reason: "incompatibleEngine";
    }
  | {
      readonly type: "failed";
      readonly reason: "incompatibleProtocol";
      readonly clientProtocol: ProtocolVersion;
      readonly serverProtocol: ProtocolVersion;
    };

export interface ObsidianSessionManagerOptions {
  readonly integration: RefineIntegration;
  readonly onError?: (error: unknown) => void;
  readonly onStateChange?: (state: ObsidianSessionState) => void;
  readonly renderExplanation?: ExplanationRenderer;
}

interface ActiveSession {
  readonly view: EditorView;
  readonly documentIdentity: object;
  readonly host: ObsidianWritingHost;
  readonly controller: AbortController;
}

export class ObsidianSessionManager {
  private readonly integration: RefineIntegration;
  private readonly onError: (error: unknown) => void;
  private readonly onStateChange: (state: ObsidianSessionState) => void;
  private readonly renderExplanation: ExplanationRenderer | undefined;
  private active: ActiveSession | undefined;
  private disposed = false;

  constructor(options: ObsidianSessionManagerOptions) {
    this.integration = options.integration;
    this.onError = options.onError ?? (() => undefined);
    this.onStateChange = options.onStateChange ?? (() => undefined);
    this.renderExplanation = options.renderExplanation;
    this.onStateChange({ type: "inactive" });
  }

  activate(view: EditorView, documentIdentity: object): void {
    if (this.disposed) {
      return;
    }
    if (
      this.active?.view === view &&
      this.active.documentIdentity === documentIdentity &&
      this.active.host.isAttached()
    ) {
      return;
    }
    this.stopActive(false);

    const controller = new AbortController();
    let session: ActiveSession | undefined;
    const host = new ObsidianWritingHost(view, {
      ...(this.renderExplanation === undefined
        ? {}
        : { renderExplanation: this.renderExplanation }),
      onPresentation: (snapshot) => {
        if (session !== undefined && this.active === session) {
          this.onStateChange({ type: "presented", snapshot });
        }
      },
    });
    session = { view, documentIdentity, host, controller };
    this.active = session;
    this.onStateChange({ type: "starting" });
    void this.integration
      .run({ host, signal: controller.signal })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && this.active === session) {
          this.onStateChange(failedSessionState(error));
          this.onError(error);
        }
      })
      .finally(() => {
        if (this.active === session) {
          this.active = undefined;
          host.close();
        }
      });
  }

  requestCheck(
    view: EditorView,
    documentIdentity: object,
    intent?: CheckIntent,
  ): void {
    this.activate(view, documentIdentity);
    if (
      this.active?.view === view &&
      this.active.documentIdentity === documentIdentity
    ) {
      this.active.host.requestCheck(intent);
    }
  }

  deactivate(view?: EditorView): void {
    if (view !== undefined && this.active?.view !== view) {
      return;
    }
    this.stopActive();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopActive();
  }

  private stopActive(notify = true): void {
    const session = this.active;
    if (!session) {
      if (notify) {
        this.onStateChange({ type: "inactive" });
      }
      return;
    }
    this.active = undefined;
    session.controller.abort();
    session.host.close();
    if (notify) {
      this.onStateChange({ type: "inactive" });
    }
  }
}

function failedSessionState(
  error: unknown,
): Extract<ObsidianSessionState, { readonly type: "failed" }> {
  if (error instanceof IncompatibleProtocolError) {
    return {
      type: "failed",
      reason: "incompatibleProtocol",
      clientProtocol: error.clientProtocol,
      serverProtocol: error.serverProtocol,
    };
  }
  if (isIncompatibleEngineError(error)) {
    return { type: "failed", reason: "incompatibleEngine" };
  }
  return { type: "failed", reason: "unavailable" };
}
