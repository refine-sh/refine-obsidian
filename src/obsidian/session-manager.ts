import type { EditorView } from "@codemirror/view";

import type {
  CheckIntent,
  PresentationSnapshot,
  RefineIntegration,
} from "../integration/types";
import { IncompatibleProtocolError } from "../transport/refine-transport";
import { ObsidianWritingHost } from "./host";

export type ObsidianSessionState =
  | { readonly type: "inactive" }
  | { readonly type: "starting" }
  | { readonly type: "presented"; readonly snapshot: PresentationSnapshot }
  | {
      readonly type: "failed";
      readonly reason: "unavailable" | "incompatibleProtocol";
    };

export interface ObsidianSessionManagerOptions {
  readonly integration: RefineIntegration;
  readonly onError?: (error: unknown) => void;
  readonly onStateChange?: (state: ObsidianSessionState) => void;
}

interface ActiveSession {
  readonly view: EditorView;
  readonly host: ObsidianWritingHost;
  readonly controller: AbortController;
}

export class ObsidianSessionManager {
  private readonly integration: RefineIntegration;
  private readonly onError: (error: unknown) => void;
  private readonly onStateChange: (state: ObsidianSessionState) => void;
  private active: ActiveSession | undefined;
  private disposed = false;

  constructor(options: ObsidianSessionManagerOptions) {
    this.integration = options.integration;
    this.onError = options.onError ?? (() => undefined);
    this.onStateChange = options.onStateChange ?? (() => undefined);
    this.onStateChange({ type: "inactive" });
  }

  activate(view: EditorView): void {
    if (this.disposed) {
      return;
    }
    if (this.active?.view === view && this.active.host.isAttached()) {
      return;
    }
    this.stopActive(false);

    const controller = new AbortController();
    let session: ActiveSession | undefined;
    const host = new ObsidianWritingHost(view, {
      onPresentation: (snapshot) => {
        if (session !== undefined && this.active === session) {
          this.onStateChange({ type: "presented", snapshot });
        }
      },
    });
    session = { view, host, controller };
    this.active = session;
    this.onStateChange({ type: "starting" });
    void this.integration
      .run({ host, signal: controller.signal })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && this.active === session) {
          this.onStateChange({
            type: "failed",
            reason: error instanceof IncompatibleProtocolError
              ? "incompatibleProtocol"
              : "unavailable",
          });
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
