import type { EditorView } from "@codemirror/view";

import type { CheckIntent, RefineIntegration } from "../integration/types";
import { ObsidianWritingHost } from "./host";

export interface ObsidianSessionManagerOptions {
  readonly integration: RefineIntegration;
  readonly onError?: (error: unknown) => void;
}

interface ActiveSession {
  readonly view: EditorView;
  readonly host: ObsidianWritingHost;
  readonly controller: AbortController;
}

export class ObsidianSessionManager {
  private readonly integration: RefineIntegration;
  private readonly onError: (error: unknown) => void;
  private active: ActiveSession | undefined;
  private disposed = false;

  constructor(options: ObsidianSessionManagerOptions) {
    this.integration = options.integration;
    this.onError = options.onError ?? (() => undefined);
  }

  activate(view: EditorView): void {
    if (this.disposed) {
      return;
    }
    if (this.active?.view === view && this.active.host.isAttached()) {
      return;
    }
    this.stopActive();

    const host = new ObsidianWritingHost(view);
    const controller = new AbortController();
    const session = { view, host, controller };
    this.active = session;
    void this.integration
      .run({ host, signal: controller.signal })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
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

  requestCheck(view: EditorView, intent?: CheckIntent): void {
    this.activate(view);
    if (this.active?.view === view) {
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

  private stopActive(): void {
    const session = this.active;
    if (!session) {
      return;
    }
    this.active = undefined;
    session.controller.abort();
    session.host.close();
  }
}
